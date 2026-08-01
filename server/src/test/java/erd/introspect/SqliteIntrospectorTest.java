package erd.introspect;

import erd.core.model.Column;
import erd.core.model.ForeignKey;
import erd.core.model.LogicalType;
import erd.core.model.TableSchema;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 追加 DB 検証（Phase 7）: SQLite。
 *
 * <p>SQLite は xerial の JDBC ドライバがプロセス内で完結するため、H2 と同様に Docker 無しで常時実行できる。
 * ここで確かめたいのは「ネームスペースの概念が無い DB でも層1（{@link JdbcIntrospector}）が破綻しないか」
 * である（{@code getSchemas()} が空 → catalog モードへフォールバックする経路。§7.3）。
 *
 * <p>スキーマは {@code dev-db/sqlite/migrations/000_init.sql}（同梱サンプルと同じ26テーブルを
 * SQLite の方言へ移植したもの）を流して作る。
 */
class SqliteIntrospectorTest {

    /** SQLite は :memory: だと接続ごとに別 DB になるため、単一コネクションを使い回す。 */
    private static Connection open() throws Exception {
        Connection conn = DriverManager.getConnection("jdbc:sqlite::memory:");
        DbTestSupport.runScript(conn, DbTestSupport.initSql("sqlite"));
        return conn;
    }

    private static RawSchema introspect(Connection conn, String ns, List<String> exclude) throws Exception {
        return new JdbcIntrospector().introspect(conn,
                new IntrospectOptions(ns, List.of(), exclude));
    }

    @Test
    @DisplayName("スキーマの無い DB（catalog フォールバック）でも標準メタデータで内省できる")
    void introspectsStandardMetadata() throws Exception {
        try (Connection conn = open()) {
            // SQLite にネームスペースは無い。namespaces() は catalog を列挙する（システム領域のみ除外）
            String ns = JdbcIntrospector.namespaces(conn).stream().findFirst().orElse("");
            RawSchema raw = introspect(conn, ns, List.of());

            // sqlite_sequence（AUTOINCREMENT の裏付け）は SYSTEM TABLE なので採用ルールで落ちる
            assertEquals(DbTestSupport.sampleTablesSorted(false),
                    raw.tables().stream().map(TableSchema::name).toList());

            TableSchema users = table(raw, "users");
            assertEquals(List.of("id", "email", "password", "created_at", "updated_at"),
                    users.columns().stream().map(Column::name).toList());
            assertEquals(List.of("id"), users.primaryKey());
            assertTrue(users.columns().get(0).autoIncrement(), "INTEGER PRIMARY KEY AUTOINCREMENT");

            Column email = column(users, "email");
            assertEquals(LogicalType.STRING, email.logicalType());
            assertFalse(email.nullable());
            assertTrue(column(users, "updated_at").nullable(), "updated_at は NULL 可");

            // PK の裏付けは畳み、UNIQUE 制約は uniques に入る。非ユニークインデックスは無い
            assertEquals(List.of("users_email_key"),
                    users.uniques().stream().map(u -> u.name()).toList());
            assertEquals(List.of(), users.indexes());

            // 型アフィニティでも正規化が成立する（numeric は DATA_TYPE=FLOAT で返ってくる）
            assertEquals(LogicalType.DECIMAL, column(table(raw, "products"), "price").logicalType());
            assertEquals(LogicalType.INT, column(table(raw, "inventories"), "quantity").logicalType());

            // 複合主キー
            assertEquals(List.of("user_id", "role_id"), table(raw, "user_roles").primaryKey());

            TableSchema orderItems = table(raw, "order_items");
            var fk = orderItems.foreignKeys().stream()
                    .filter(f -> f.columns().equals(List.of("order_id"))).findFirst().orElseThrow();
            assertTrue(fk.ref().table().endsWith("orders"), fk.ref().table());
            assertEquals(List.of("id"), fk.ref().columns());
            // 移植元（同梱サンプル）は ON DELETE を指定していないため既定の no action になる
            assertEquals(ForeignKey.DEFAULT_ACTION, fk.onDelete());
        }
    }

    @Test
    @DisplayName("T-1: 同じ DB を2回内省したら正規化後のモデルが完全に一致する")
    void introspectionIsStable() throws Exception {
        try (Connection conn = open()) {
            String ns = JdbcIntrospector.namespaces(conn).stream().findFirst().orElse("");
            assertEquals(introspect(conn, ns, List.of()).tables(),
                    introspect(conn, ns, List.of()).tables());
        }
    }

    @Test
    @DisplayName("K-06: 今回の内省に限った除外パターンが効く")
    void scopeExclude() throws Exception {
        try (Connection conn = open()) {
            String ns = JdbcIntrospector.namespaces(conn).stream().findFirst().orElse("");
            RawSchema raw = introspect(conn, ns, List.of("point*"));

            List<String> names = raw.tables().stream().map(TableSchema::name).toList();
            assertEquals(DbTestSupport.SAMPLE_TABLES.size() - 4, names.size());
            assertTrue(names.stream().noneMatch(n -> n.startsWith("point")), names.toString());
        }
    }

    @Test
    @DisplayName("K-16: ビューを取り込み、内部テーブル（sqlite_*）は種別で除外される")
    void introspectsViews() throws Exception {
        try (Connection conn = open()) {
            try (var st = conn.createStatement()) {
                st.execute("CREATE VIEW v_users AS SELECT id, email FROM users");
            }
            String ns = JdbcIntrospector.namespaces(conn).stream().findFirst().orElse("");
            RawSchema raw = introspect(conn, ns, List.of());

            // sqlite_schema / sqlite_sequence は SYSTEM TABLE なので採用ルールで落ちる
            List<String> names = raw.tables().stream().map(TableSchema::name).toList();
            assertTrue(names.contains("v_users"), names.toString());
            assertEquals(DbTestSupport.SAMPLE_TABLES.size() + 1, names.size());
            assertTrue(names.stream().noneMatch(n -> n.startsWith("sqlite_")), names.toString());

            TableSchema view = table(raw, "v_users");
            assertEquals("VIEW", view.kind());
            assertFalse(view.isTable());
            assertTrue(table(raw, "users").isTable());
        }
    }

    private static TableSchema table(RawSchema raw, String name) {
        return raw.tables().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow();
    }

    private static Column column(TableSchema t, String name) {
        return t.columns().stream().filter(c -> c.name().equals(name)).findFirst().orElseThrow();
    }
}
