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
        // 冪等化: FK を持つ側から先に落とす
        DbTestSupport.runIgnoring(conn,
                "DROP TABLE dbo.orders", "DROP TABLE dbo.users", "DROP TABLE dbo.flyway_schema_history");
        DbTestSupport.runScript(conn, DbTestSupport.ddl("sqlserver"));
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
    @DisplayName("スキーマモード・IDENTITY・NVARCHAR/BIT/DATETIME2/NUMERIC を標準メタデータで内省する")
    void introspectsStandardMetadata() throws Exception {
        RawSchema raw = introspect(List.of());
        assertTrue(raw.product().toLowerCase().contains("sql server"), raw.product());

        assertEquals(List.of("flyway_schema_history", "orders", "users"),
                raw.tables().stream().map(TableSchema::name).toList());

        TableSchema users = table(raw, "users");
        assertEquals(List.of("id", "email", "org_id", "is_active", "created_at"),
                users.columns().stream().map(Column::name).toList());
        assertEquals(List.of("id"), users.primaryKey());
        assertTrue(users.columns().get(0).autoIncrement(), "IDENTITY 列");

        Column email = users.columns().get(1);
        assertEquals(LogicalType.STRING, email.logicalType());
        assertFalse(email.nullable());
        assertTrue(users.columns().get(2).nullable(), "org_id は NULL 可");
        assertEquals(LogicalType.BOOL, column(users, "is_active").logicalType(), "BIT は bool");
        assertEquals(LogicalType.DATETIME, column(users, "created_at").logicalType());

        // PK の裏付けインデックスは畳み、ユニーク / 非ユニークを振り分ける（§7.4）
        assertEquals(List.of("users_email_key"),
                users.uniques().stream().map(u -> u.name()).toList());
        assertEquals(List.of("idx_users_created_at"),
                users.indexes().stream().map(i -> i.name()).toList());

        TableSchema orders = table(raw, "orders");
        assertEquals(LogicalType.DECIMAL, column(orders, "total").logicalType());
        var fk = orders.foreignKeys().get(0);
        assertEquals("orders_user_id_fkey", fk.name());
        assertEquals(List.of("user_id"), fk.columns());
        assertTrue(fk.ref().table().endsWith("users"), fk.ref().table());
        assertEquals(List.of("id"), fk.ref().columns());
        assertEquals("cascade", fk.onDelete());
    }

    @Test
    @DisplayName("T-1: 同じ DB を2回内省したら正規化後のモデルが完全に一致する")
    void introspectionIsStable() throws Exception {
        assertEquals(introspect(List.of()).tables(), introspect(List.of()).tables());
    }

    @Test
    @DisplayName("K-06: 今回の内省に限った除外パターンが効く")
    void scopeExclude() throws Exception {
        RawSchema raw = introspect(List.of("flyway_*"));
        assertEquals(List.of("orders", "users"),
                raw.tables().stream().map(TableSchema::name).toList());
    }

    private static TableSchema table(RawSchema raw, String name) {
        return raw.tables().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow();
    }

    private static Column column(TableSchema t, String name) {
        return t.columns().stream().filter(c -> c.name().equals(name)).findFirst().orElseThrow();
    }
}
