package erd.introspect;

import erd.core.model.Column;
import erd.core.model.LogicalType;
import erd.core.model.TableSchema;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 層1（JDBC 標準メタデータ）の内省（§7.1 / §7.3）。
 *
 * <p>H2 を使うのは「DatabaseMetaData だけで完結しているか」を実 DB で確かめるためである。
 * PostgreSQL / MySQL 固有の挙動（コメント・unsigned・配列）の検証は Testcontainers で別途行う。
 */
class JdbcIntrospectorTest {

    private static final String DDL = """
            CREATE SCHEMA IF NOT EXISTS "public";
            CREATE TABLE "public"."users" (
              "id" BIGINT AUTO_INCREMENT PRIMARY KEY,
              "email" VARCHAR(255) NOT NULL,
              "org_id" BIGINT,
              "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            COMMENT ON TABLE "public"."users" IS 'ユーザーマスタ';
            COMMENT ON COLUMN "public"."users"."email" IS 'メールアドレス';
            CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email");
            CREATE INDEX "idx_users_created_at" ON "public"."users"("created_at");
            CREATE TABLE "public"."orders" (
              "id" BIGINT AUTO_INCREMENT PRIMARY KEY,
              "user_id" BIGINT NOT NULL,
              "total" NUMERIC(12,2) NOT NULL,
              CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id")
                REFERENCES "public"."users"("id") ON DELETE CASCADE
            );
            CREATE TABLE "public"."flyway_schema_history" ("installed_rank" INT PRIMARY KEY);
            """;

    static Connection open(String name) throws SQLException {
        Connection conn = DriverManager.getConnection("jdbc:h2:mem:" + name + ";DB_CLOSE_DELAY=-1");
        try (Statement st = conn.createStatement()) {
            st.execute(DDL);
        }
        return conn;
    }

    private static RawSchema introspect(Connection conn, List<String> exclude) throws SQLException {
        return new JdbcIntrospector().introspect(conn,
                new IntrospectOptions("public", List.of(), exclude));
    }

    @Test
    @DisplayName("カラム・主キー・ユニーク・インデックス・外部キーを標準メタデータだけで取得する")
    void introspectsStandardMetadata() throws Exception {
        try (Connection conn = open("intro1")) {
            RawSchema raw = introspect(conn, List.of());

            assertEquals(List.of("flyway_schema_history", "orders", "users"),
                    raw.tables().stream().map(TableSchema::name).toList());

            TableSchema users = raw.tables().stream()
                    .filter(t -> t.name().equals("users")).findFirst().orElseThrow();
            assertEquals("public.users", RawSchema.idOf(users));
            assertEquals("ユーザーマスタ", users.comment());
            assertEquals(List.of("id"), users.primaryKey());

            assertEquals(List.of("id", "email", "org_id", "created_at"),
                    users.columns().stream().map(Column::name).toList());
            Column email = users.columns().get(1);
            // type は DB が返した TYPE_NAME の原文（H2 は "CHARACTER VARYING"）。忠実性を優先し、
            // 表示・比較には正規化型（logicalType）を使う（§5.7）
            assertEquals("character varying(255)", email.type());
            assertEquals(LogicalType.STRING, email.logicalType());
            assertFalse(email.nullable());
            assertEquals("メールアドレス", email.comment());
            assertTrue(users.columns().get(2).nullable());
            assertTrue(users.columns().get(0).autoIncrement());

            // 主キーの裏付けインデックスは畳み、ユニーク制約とインデックスを振り分ける（§7.4）
            assertEquals(List.of("users_email_key"),
                    users.uniques().stream().map(u -> u.name()).toList());
            assertEquals(List.of("idx_users_created_at"),
                    users.indexes().stream().map(i -> i.name()).toList());

            TableSchema orders = raw.tables().stream()
                    .filter(t -> t.name().equals("orders")).findFirst().orElseThrow();
            var fk = orders.foreignKeys().get(0);
            assertEquals(List.of("user_id"), fk.columns());
            assertEquals("public.users", fk.ref().table());
            assertEquals(List.of("id"), fk.ref().columns());
            assertEquals("cascade", fk.onDelete());
            assertEquals(LogicalType.DECIMAL, orders.columns().get(2).logicalType());
            assertEquals("numeric(12,2)", orders.columns().get(2).type());
        }
    }

    @Test
    @DisplayName("T-1: 同じ DB を2回内省したら、正規化後のモデルが完全に一致する")
    void introspectionIsStable() throws Exception {
        try (Connection conn = open("intro2")) {
            assertEquals(introspect(conn, List.of()).tables(), introspect(conn, List.of()).tables());
        }
    }

    @Test
    @DisplayName("K-06: 今回の内省に限った除外パターン（テーブル名・完全修飾ID のどちらでも効く）")
    void scopeExclude() throws Exception {
        try (Connection conn = open("intro3")) {
            RawSchema raw = introspect(conn, List.of("flyway_*"));
            assertEquals(List.of("orders", "users"),
                    raw.tables().stream().map(TableSchema::name).toList());

            RawSchema byId = introspect(conn, List.of("public.orders"));
            assertEquals(List.of("flyway_schema_history", "users"),
                    byId.tables().stream().map(TableSchema::name).toList());
        }
    }

    @Test
    @DisplayName("K-04: ネームスペース一覧からシステム領域を除く")
    void listsNamespaces() throws Exception {
        try (Connection conn = open("intro4")) {
            List<String> namespaces = JdbcIntrospector.namespaces(conn);
            assertTrue(namespaces.contains("public"));
            assertFalse(namespaces.contains("INFORMATION_SCHEMA"));
        }
    }

    @Test
    @DisplayName("K-16: ビューを取り込み、H2 の BASE TABLE を TABLE に正規化する")
    void introspectsViews() throws Exception {
        try (Connection conn = open("introView")) {
            try (Statement st = conn.createStatement()) {
                st.execute("CREATE VIEW \"public\".\"v_active_users\" AS "
                        + "SELECT \"id\", \"email\" FROM \"public\".\"users\"");
            }
            RawSchema raw = introspect(conn, List.of());

            assertEquals(List.of("flyway_schema_history", "orders", "users", "v_active_users"),
                    raw.tables().stream().map(TableSchema::name).toList());

            // H2 は TABLE_TYPE に "BASE TABLE" を返す。畳まないと全テーブルが「特殊」になる
            assertEquals("TABLE", table(raw, "users").kind());
            assertTrue(table(raw, "users").isTable());

            TableSchema view = table(raw, "v_active_users");
            assertEquals("VIEW", view.kind());
            assertFalse(view.isTable());
            assertEquals(List.of("id", "email"),
                    view.columns().stream().map(Column::name).toList());
            // ビューは制約を持たない。例外にはならず空で返る
            assertTrue(view.primaryKey().isEmpty());
            assertTrue(view.uniques().isEmpty());
            assertTrue(view.foreignKeys().isEmpty());
        }
    }

    @Test
    @DisplayName("K-16: 種別の採否は名前の規則だけで決める（DB 製品ごとの分岐を持たない）")
    void relationLikeRule() {
        // 実測した5 DB が返す種別名（K-16 詳細設計 §2）を、そのまま規則に当てる
        for (String accepted : List.of("TABLE", "BASE TABLE", "VIEW", "MATERIALIZED VIEW",
                "PARTITIONED TABLE", "FOREIGN TABLE")) {
            assertTrue(JdbcIntrospector.isRelationLike(accepted), accepted);
        }
        for (String rejected : List.of("INDEX", "PARTITIONED INDEX", "SEQUENCE", "TYPE",
                "SYNONYM", "ALIAS", "SYSTEM TABLE", "SYSTEM VIEW", "SYSTEM TOAST TABLE")) {
            assertFalse(JdbcIntrospector.isRelationLike(rejected), rejected);
        }
        assertFalse(JdbcIntrospector.isRelationLike(null));

        // 正規化するのは SQL 標準の別名だけ。意味を落とす正規化はしない
        assertEquals("TABLE", JdbcIntrospector.normalizeKind("BASE TABLE"));
        assertEquals("TABLE", JdbcIntrospector.normalizeKind(null));
        assertEquals("TABLE", JdbcIntrospector.normalizeKind("  "));
        assertEquals("MATERIALIZED VIEW", JdbcIntrospector.normalizeKind("MATERIALIZED VIEW"));
        assertEquals("VIEW", JdbcIntrospector.normalizeKind(" VIEW "));
    }

    private static TableSchema table(RawSchema raw, String name) {
        return raw.tables().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow();
    }
}
