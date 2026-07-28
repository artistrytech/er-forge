package erd.introspect;

import erd.core.model.Column;
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
 */
class SqliteIntrospectorTest {

    /** SQLite は :memory: だと接続ごとに別 DB になるため、単一コネクションを使い回す。 */
    private static Connection open() throws Exception {
        Connection conn = DriverManager.getConnection("jdbc:sqlite::memory:");
        DbTestSupport.runScript(conn, DbTestSupport.ddl("sqlite"));
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

            assertEquals(List.of("flyway_schema_history", "orders", "users"),
                    raw.tables().stream().map(TableSchema::name).toList());

            TableSchema users = table(raw, "users");
            assertEquals(List.of("id", "email", "org_id", "created_at"),
                    users.columns().stream().map(Column::name).toList());
            assertEquals(List.of("id"), users.primaryKey());
            assertTrue(users.columns().get(0).autoIncrement(), "INTEGER PRIMARY KEY AUTOINCREMENT");

            Column email = users.columns().get(1);
            assertEquals(LogicalType.STRING, email.logicalType());
            assertFalse(email.nullable());
            assertTrue(users.columns().get(2).nullable(), "org_id は NULL 可");

            // 主キーの裏付けを畳み、ユニークとインデックスを振り分ける（§7.4）
            assertEquals(List.of("users_email_key"),
                    users.uniques().stream().map(u -> u.name()).toList());
            assertEquals(List.of("idx_users_created_at"),
                    users.indexes().stream().map(i -> i.name()).toList());

            TableSchema orders = table(raw, "orders");
            assertEquals(LogicalType.DECIMAL, orders.columns().get(2).logicalType());
            var fk = orders.foreignKeys().get(0);
            assertEquals(List.of("user_id"), fk.columns());
            assertTrue(fk.ref().table().endsWith("users"));
            assertEquals(List.of("id"), fk.ref().columns());
            assertEquals("cascade", fk.onDelete());
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
            RawSchema raw = introspect(conn, ns, List.of("flyway_*"));
            assertEquals(List.of("orders", "users"),
                    raw.tables().stream().map(TableSchema::name).toList());
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
            assertEquals(List.of("flyway_schema_history", "orders", "users", "v_users"),
                    raw.tables().stream().map(TableSchema::name).toList());

            TableSchema view = table(raw, "v_users");
            assertEquals("VIEW", view.kind());
            assertFalse(view.isTable());
            assertTrue(table(raw, "users").isTable());
        }
    }

    private static TableSchema table(RawSchema raw, String name) {
        return raw.tables().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow();
    }
}
