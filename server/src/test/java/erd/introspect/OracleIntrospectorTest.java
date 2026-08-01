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
import java.util.Properties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 追加 DB 検証（Phase 7）: Oracle。
 *
 * <p>dev-db の docker compose（{@code oracle} サービス、gvenzl/oracle-free）に接続して検証する。
 * 起動していない場合は skip する。
 *
 * <pre>
 *   cd dev-db &amp;&amp; docker compose up -d oracle
 *   cd server &amp;&amp; ./gradlew test --tests 'erd.introspect.OracleIntrospectorTest'
 * </pre>
 *
 * <p>Oracle 固有の確認点:
 * <ul>
 *   <li>識別子を既定で大文字に畳む（テーブル名・カラム名が大文字で返る）</li>
 *   <li>表・列コメントは接続プロパティ {@code oracle.jdbc.remarksReporting=true} を付けないと
 *       REMARKS に出ない（K-14 のコメント補完に必要）</li>
 *   <li>{@code NUMBER} は固定小数点（decimal）扱いになる</li>
 * </ul>
 */
class OracleIntrospectorTest {

    private static final String URL = "jdbc:oracle:thin:@localhost:1521/FREEPDB1";
    private static final String NS = "ERD";  // 接続ユーザー = スキーマ（大文字）

    private Connection conn;

    @BeforeEach
    void setUp() throws Exception {
        Properties props = new Properties();
        props.put("oracle.jdbc.remarksReporting", "true");  // コメントを REMARKS に載せる
        conn = DbTestSupport.tryOpen(URL, "ERD", "erd", props);
        assumeTrue(conn != null, "Oracle (dev-db docker compose) is not reachable; skipping");
        String sql = DbTestSupport.initSql("oracle");
        // CASCADE CONSTRAINTS を付けるので落とす順序は問わないが、逆順で子から消す
        DbTestSupport.dropAll(conn, sql, "", " CASCADE CONSTRAINTS");
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
    @DisplayName("大文字識別子・IDENTITY・NUMBER/VARCHAR2/TIMESTAMP/CLOB・コメントを内省する")
    void introspectsStandardMetadata() throws Exception {
        RawSchema raw = introspect(List.of());
        assertTrue(raw.product().toLowerCase().contains("oracle"), raw.product());

        // Oracle は識別子を大文字に畳む
        assertEquals(DbTestSupport.sampleTablesSorted(true),
                raw.tables().stream().map(TableSchema::name).toList());

        TableSchema users = table(raw, "USERS");
        assertEquals(List.of("ID", "EMAIL", "PASSWORD", "CREATED_AT", "UPDATED_AT"),
                users.columns().stream().map(Column::name).toList());
        assertEquals(List.of("ID"), users.primaryKey());
        assertTrue(users.columns().get(0).autoIncrement(), "GENERATED AS IDENTITY");

        Column email = column(users, "EMAIL");
        assertEquals(LogicalType.STRING, email.logicalType());
        assertFalse(email.nullable());
        assertEquals(LogicalType.DATETIME, column(users, "CREATED_AT").logicalType());
        assertEquals(LogicalType.STRING,
                column(table(raw, "PRODUCTS"), "DESCRIPTION").logicalType(), "CLOB は string");

        // コメントからの論理名補完（K-14 / P-02）に使う REMARKS を確認する。
        // 移植元（同梱サンプル）が持つのは表コメントだけで、列コメントは無い
        assertEquals("ユーザー情報", users.comment());
        assertEquals("商品レビュー", table(raw, "PRODUCT_REVIEWS").comment());

        // PK の裏付けインデックスは畳み、UNIQUE 制約の裏付けだけが uniques に残る
        assertEquals(List.of("USERS_EMAIL_KEY"),
                users.uniques().stream().map(u -> u.name()).toList());
        assertEquals(List.of(), users.indexes());

        // Oracle の NUMBER 系は桁の有無によらず固定小数点（decimal）として正規化される
        assertEquals(LogicalType.DECIMAL,
                column(table(raw, "ORDER_ITEMS"), "PRICE").logicalType());
        assertEquals(LogicalType.DECIMAL,
                column(table(raw, "ORDER_ITEMS"), "QUANTITY").logicalType());

        // COMMENT は Oracle の予約語のため DDL で引用符を付けている（内省では他の列と同じ大文字）
        assertEquals(LogicalType.STRING,
                column(table(raw, "PRODUCT_REVIEWS"), "COMMENT").logicalType());

        // 複合主キー
        assertEquals(List.of("USER_ID", "ROLE_ID"), table(raw, "USER_ROLES").primaryKey());

        TableSchema orderItems = table(raw, "ORDER_ITEMS");
        var fk = orderItems.foreignKeys().stream()
                .filter(f -> f.columns().equals(List.of("ORDER_ID"))).findFirst().orElseThrow();
        assertTrue(fk.ref().table().toUpperCase().endsWith("ORDERS"), fk.ref().table());
        assertEquals(List.of("ID"), fk.ref().columns());
        // 移植元（同梱サンプル）は ON DELETE を指定していない。Oracle には NO ACTION が無く、
        // ドライバは DELETE_RULE = importedKeyRestrict を返すため restrict になる
        // （MySQL も restrict。SQL Server / SQLite は同じ DDL で no action。製品差がそのまま出る）
        assertEquals("restrict", fk.onDelete());
    }

    @Test
    @DisplayName("T-1: 同じ DB を2回内省したら正規化後のモデルが完全に一致する")
    void introspectionIsStable() throws Exception {
        assertEquals(introspect(List.of()).tables(), introspect(List.of()).tables());
    }

    @Test
    @DisplayName("K-06: 今回の内省に限った除外パターンが効く")
    void scopeExclude() throws Exception {
        RawSchema raw = introspect(List.of("POINT*"));
        List<String> names = raw.tables().stream().map(TableSchema::name).toList();
        assertEquals(DbTestSupport.SAMPLE_TABLES.size() - 4, names.size());
        assertTrue(names.stream().noneMatch(n -> n.startsWith("POINT")), names.toString());
    }

    private static TableSchema table(RawSchema raw, String name) {
        return raw.tables().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow();
    }

    private static Column column(TableSchema t, String name) {
        return t.columns().stream().filter(c -> c.name().equals(name)).findFirst().orElseThrow();
    }
}
