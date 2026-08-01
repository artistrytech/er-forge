package erd.introspect;

import erd.core.model.Column;
import erd.core.model.ForeignKey;
import erd.core.model.LogicalType;
import erd.core.model.TableSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 追加 DB 検証（Phase 7）: SQL Server。
 *
 * <p>dev-db の docker compose（{@code sqlserver} サービス）に接続して検証する。
 * 起動していない場合は {@link org.junit.jupiter.api.Assumptions#assumeTrue} で skip する
 * （Docker を必須ゲートにしない。§2.1 の Testcontainers と同じ扱い）。
 *
 * <pre>
 *   cd dev-db &amp;&amp; docker compose up -d sqlserver
 *   cd server &amp;&amp; ./gradlew test --tests 'erd.introspect.SqlServerIntrospectorTest'
 * </pre>
 */
class SqlServerIntrospectorTest {

    private static final String URL =
            "jdbc:sqlserver://localhost:1433;databaseName=erd_sample;encrypt=false;trustServerCertificate=true";
    private static final String NS = "dbo";

    private Connection conn;

    @BeforeEach
    void setUp() throws Exception {
        conn = DbTestSupport.tryOpen(URL, "sa", "Erd_password1", null);
        assumeTrue(conn != null, "SQL Server (dev-db docker compose) is not reachable; skipping");
        String sql = DbTestSupport.initSql("sqlserver");
        // 冪等化: 作成の逆順に落とす（FK を持つ子テーブルから先に消える）
        DbTestSupport.dropAll(conn, sql, "dbo.", "");
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
    @DisplayName("スキーマモード・IDENTITY・NVARCHAR/DATETIME2/NUMERIC/DATE を標準メタデータで内省する")
    void introspectsStandardMetadata() throws Exception {
        RawSchema raw = introspect(List.of());
        assertTrue(raw.product().toLowerCase().contains("sql server"), raw.product());

        assertEquals(DbTestSupport.sampleTablesSorted(false),
                raw.tables().stream().map(TableSchema::name).toList());

        TableSchema users = table(raw, "users");
        assertEquals(List.of("id", "email", "password", "created_at", "updated_at"),
                users.columns().stream().map(Column::name).toList());
        assertEquals(List.of("id"), users.primaryKey());
        assertTrue(users.columns().get(0).autoIncrement(), "IDENTITY 列");

        Column email = column(users, "email");
        assertEquals(LogicalType.STRING, email.logicalType());
        assertFalse(email.nullable());
        assertTrue(column(users, "created_at").nullable(), "created_at は NULL 可");
        assertEquals(LogicalType.DATETIME, column(users, "created_at").logicalType());

        TableSchema profiles = table(raw, "user_profiles");
        assertEquals(LogicalType.DATE, column(profiles, "birth_date").logicalType());
        assertEquals(LogicalType.STRING,
                column(table(raw, "products"), "description").logicalType(), "NVARCHAR(MAX) は string");
        assertEquals(LogicalType.DECIMAL, column(table(raw, "products"), "price").logicalType());
        assertEquals(LogicalType.INT, column(table(raw, "inventories"), "quantity").logicalType());

        // PK の裏付けインデックスは畳み、UNIQUE 制約の裏付けだけが uniques に残る（§7.4）
        assertEquals(List.of("users_email_key"),
                users.uniques().stream().map(u -> u.name()).toList());
        assertEquals(List.of(), users.indexes());

        // 複合主キー
        assertEquals(List.of("product_id", "tag_id"), table(raw, "product_tag_mappings").primaryKey());

        TableSchema orderItems = table(raw, "order_items");
        var fk = orderItems.foreignKeys().stream()
                .filter(f -> f.name().equals("order_items_order_id_fkey")).findFirst().orElseThrow();
        assertEquals(List.of("order_id"), fk.columns());
        assertTrue(fk.ref().table().endsWith("orders"), fk.ref().table());
        assertEquals(List.of("id"), fk.ref().columns());
        // 移植元（同梱サンプル）は ON DELETE を指定していないため既定の no action になる
        assertEquals(ForeignKey.DEFAULT_ACTION, fk.onDelete());
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
