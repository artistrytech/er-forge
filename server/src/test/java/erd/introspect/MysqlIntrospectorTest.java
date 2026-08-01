package erd.introspect;

import erd.core.model.Column;
import erd.core.model.LogicalType;
import erd.core.model.TableSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.util.List;
import java.util.Properties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * MySQL の内省検証。
 *
 * <p>dev-db の docker compose（{@code mysql} サービス）に接続して検証する。
 * 起動していない場合は skip する。
 *
 * <pre>
 *   cd dev-db &amp;&amp; docker compose --profile mysql up -d
 *   cd server &amp;&amp; ./gradlew test --tests 'erd.introspect.MysqlIntrospectorTest'
 * </pre>
 *
 * <p>MySQL は PostgreSQL と並んで<b>層2（{@link MysqlEnhancer}）を持つ</b>ため、
 * 層1だけの SQL Server / Oracle / SQLite とは確認点が違う。
 * <ul>
 *   <li>スキーマ（ネームスペース）が無く、データベースが catalog になる（catalog モード。§7.3）</li>
 *   <li>{@code AUTO_INCREMENT} が autoIncrement として取れる</li>
 *   <li>表コメントが {@code REMARKS} に出る（コメント補完 K-14 の前提）</li>
 *   <li>FK を張ると InnoDB が裏でインデックスを作るため、{@code indexes} に現れる</li>
 *   <li>層2 が CHECK 制約を {@code dialect.checks} に載せる（JDBC 標準に API が無い）</li>
 * </ul>
 */
class MysqlIntrospectorTest {

    private static final String URL = "jdbc:mysql://localhost:3346/erd_sample";
    private static final String NS = "erd_sample";  // MySQL はデータベース = catalog

    private Connection conn;

    @BeforeEach
    void setUp() throws Exception {
        Properties props = new Properties();
        // 表・列コメントを REMARKS に載せる（付けないと空になる）
        props.put("useInformationSchema", "true");
        conn = DbTestSupport.tryOpen(URL, "erd", "erd", props);
        assumeTrue(conn != null, "MySQL (dev-db docker compose) is not reachable; skipping");
        String sql = DbTestSupport.initSql("mysql");
        // 冪等化: 作成の逆順に落とす（FK を持つ子テーブルから先に消える）
        DbTestSupport.dropAll(conn, sql, "", "");
        DbTestSupport.runScript(conn, sql);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (conn != null) conn.close();
    }

    private RawSchema introspect(List<String> exclude) throws Exception {
        return new JdbcIntrospector().introspect(conn,
                new IntrospectOptions(NS, List.of(), exclude));
    }

    @Test
    @DisplayName("catalog モード・AUTO_INCREMENT・型の正規化・コメントを標準メタデータで内省する")
    void introspectsStandardMetadata() throws Exception {
        RawSchema raw = introspect(List.of());
        assertTrue(raw.product().toLowerCase().contains("mysql"), raw.product());

        assertEquals(DbTestSupport.sampleTablesSorted(false),
                raw.tables().stream().map(TableSchema::name).toList());

        TableSchema users = table(raw, "users");
        assertEquals(List.of("id", "email", "password", "created_at", "updated_at"),
                users.columns().stream().map(Column::name).toList());
        assertEquals(List.of("id"), users.primaryKey());
        assertTrue(users.columns().get(0).autoIncrement(), "AUTO_INCREMENT 列");

        Column email = column(users, "email");
        assertEquals(LogicalType.STRING, email.logicalType());
        assertFalse(email.nullable());
        assertEquals(LogicalType.DATETIME, column(users, "created_at").logicalType());
        assertEquals(LogicalType.DATE,
                column(table(raw, "user_profiles"), "birth_date").logicalType());
        assertEquals(LogicalType.STRING,
                column(table(raw, "products"), "description").logicalType(), "TEXT は string");
        assertEquals(LogicalType.DECIMAL, column(table(raw, "products"), "price").logicalType());
        assertEquals(LogicalType.INT, column(table(raw, "inventories"), "quantity").logicalType());

        // コメントからの論理名補完（K-14 / P-02）に使う REMARKS。移植元が持つのは表コメントだけ
        assertEquals("ユーザー情報", users.comment());
        assertEquals("商品レビュー", table(raw, "product_reviews").comment());

        // PK の裏付けインデックスは畳み、UNIQUE 制約の裏付けだけが uniques に残る
        assertEquals(List.of("users_email_key"),
                users.uniques().stream().map(u -> u.name()).toList());
        assertEquals(List.of(), users.indexes());

        // FK を張ると InnoDB が裏でインデックスを作る（制約名と同じ名前で indexes に出る）
        assertEquals(List.of("user_profiles_user_id_fkey"),
                table(raw, "user_profiles").indexes().stream().map(i -> i.name()).toList());

        // 複合主キー
        assertEquals(List.of("user_id", "role_id"), table(raw, "user_roles").primaryKey());

        TableSchema orderItems = table(raw, "order_items");
        var fk = orderItems.foreignKeys().stream()
                .filter(f -> f.name().equals("order_items_order_id_fkey")).findFirst().orElseThrow();
        assertEquals(List.of("order_id"), fk.columns());
        assertTrue(fk.ref().table().endsWith("orders"), fk.ref().table());
        assertEquals(List.of("id"), fk.ref().columns());
        // 移植元（同梱サンプル）は ON DELETE を指定していない。InnoDB の既定は RESTRICT で、
        // NO ACTION も同義として扱われるため restrict になる（Oracle と同じ。SQL Server /
        // SQLite は同じ DDL で no action。FK の削除規則は製品差がそのまま出る）
        assertEquals("restrict", fk.onDelete());
    }

    @Test
    @DisplayName("層2（MysqlEnhancer）が CHECK 制約を dialect に載せる")
    void enhancerAddsChecks() throws Exception {
        RawSchema raw = Dialects.enhance(conn, introspect(List.of()));

        TableSchema reviews = table(raw, "product_reviews");
        var checks = reviews.dialect().get("checks");
        assertTrue(checks != null && checks.isArray() && !checks.isEmpty(),
                "dialect.checks: " + reviews.dialect());
        assertTrue(checks.toString().contains("product_reviews_rating_check"), checks.toString());

        // CHECK を持たないテーブルには dialect を作らない（出力を汚さない）
        assertFalse(table(raw, "roles").dialect().containsKey("checks"));
    }

    @Test
    @DisplayName("T-1: 同じ DB を2回内省したら正規化後のモデルが完全に一致する")
    void introspectionIsStable() throws Exception {
        assertEquals(introspect(List.of()).tables(), introspect(List.of()).tables());
    }

    @Test
    @DisplayName("K-06: 今回の内省に限った除外パターンが効く")
    void scopeExclude() throws Exception {
        RawSchema raw = introspect(List.of("point*"));
        List<String> names = raw.tables().stream().map(TableSchema::name).toList();
        assertEquals(DbTestSupport.SAMPLE_TABLES.size() - 4, names.size());
        assertTrue(names.stream().noneMatch(n -> n.startsWith("point")), names.toString());
    }

    private static TableSchema table(RawSchema raw, String name) {
        return raw.tables().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow();
    }

    private static Column column(TableSchema t, String name) {
        return t.columns().stream().filter(c -> c.name().equals(name)).findFirst().orElseThrow();
    }
}
