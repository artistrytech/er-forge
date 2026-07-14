package erd.introspect;

import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.model.Column;
import erd.core.model.LogicalType;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 層2（DialectEnhancer）が組み立てる dialect の検証。
 *
 * <p>実 DB に対する内省（PostgreSQL / MySQL の pg_catalog / information_schema）は
 * Testcontainers の担当であり、ここでは <b>SQL の結果をモデルに落とし込む部分</b>
 * ——決定論性・スキーマファイルへの往復・失敗時の縮退——を固定する。
 */
class DialectsTest {

    private static RawSchema schemaOf(String... tableNames) {
        List<TableSchema> tables = java.util.Arrays.stream(tableNames)
                .map(n -> new TableSchema(n, "public", null,
                        List.of(new Column("id", "int4", LogicalType.INT, false)),
                        List.of("id"), List.of(), List.of(), List.of(), Map.of()))
                .toList();
        return new RawSchema("PostgreSQL", "16.2", "pgjdbc", "public", tables, List.of());
    }

    /** dialect が空のテーブルには dialect キー自体を作らない（§5.11 の省略規則）。 */
    @Test
    void tablesWithoutDialectAreUntouched() {
        RawSchema schema = schemaOf("users");
        RawSchema merged = Dialects.merge(schema, Map.of("orders", new Dialects.Builder()));

        assertSame(schema.tables().get(0), merged.tables().get(0));
        assertTrue(merged.tables().get(0).dialect().isEmpty());
    }

    /**
     * 出力は決定論的でなければならない（キー順が揺れると意味のない Git 差分が出る）。
     * 投入順が違っても、checks / enums / indexes の順、各要素は名前昇順に揃う。
     */
    @Test
    void dialectIsOrderedDeterministically() {
        Dialects.Builder a = new Dialects.Builder();
        a.addIndex("idx_active", "CREATE INDEX ...", "(deleted_at IS NULL)");
        a.addCheck("users_age_check", "CHECK ((age >= 0))");
        a.addEnum("status", List.of("active", "banned"));
        a.addCheck("users_email_check", "CHECK ((email <> ''::text))");

        Dialects.Builder b = new Dialects.Builder();
        b.addCheck("users_email_check", "CHECK ((email <> ''::text))");
        b.addEnum("status", List.of("active", "banned"));
        b.addCheck("users_age_check", "CHECK ((age >= 0))");
        b.addIndex("idx_active", "CREATE INDEX ...", "(deleted_at IS NULL)");

        String first = print(Dialects.merge(schemaOf("users"), Map.of("users", a)));
        String second = print(Dialects.merge(schemaOf("users"), Map.of("users", b)));

        assertEquals(first, second);
        assertTrue(first.indexOf("checks") < first.indexOf("enums"));
        assertTrue(first.indexOf("enums") < first.indexOf("indexes"));
        // CHECK は名前昇順（投入順ではない）
        assertTrue(first.indexOf("users_age_check") < first.indexOf("users_email_check"));
    }

    /** dialect を含むスキーマファイルが、決定論的プリンタで往復してバイト単位で一致する。 */
    @Test
    void dialectRoundTripsThroughTheDataFile() {
        Dialects.Builder builder = new Dialects.Builder();
        builder.addCheck("users_age_check", "CHECK ((age >= 0))");
        builder.addEnum("status", List.of("active", "banned"));
        builder.addIndex("idx_users_active", "CREATE INDEX ...", "(deleted_at IS NULL)");

        String printed = print(Dialects.merge(schemaOf("users"), Map.of("users", builder)));
        Table reparsed = new DataFileParser().parseTable(printed).value();

        assertEquals(printed, new DataFilePrinter().printTable(reparsed));
        assertEquals(List.of("checks", "enums", "indexes"),
                List.copyOf(reparsed.schema().dialect().keySet()));
        assertEquals("[\"active\",\"banned\"]",
                reparsed.schema().dialect().get("enums").get("status").toString());
    }

    /** MySQL の COLUMN_TYPE は enum('a','b') の形で返る。値の中の '' はリテラルの ' である。 */
    @Test
    void parsesMysqlEnumValues() {
        assertEquals(List.of("active", "banned"),
                MysqlEnhancer.parseEnumValues("enum('active','banned')"));
        assertEquals(List.of("a,b", "c"), MysqlEnhancer.parseEnumValues("set('a,b','c')"));
        assertEquals(List.of("it's"), MysqlEnhancer.parseEnumValues("enum('it''s')"));
        assertEquals(List.of(), MysqlEnhancer.parseEnumValues("varchar(255)"));
        assertEquals(List.of(), MysqlEnhancer.parseEnumValues(null));
    }

    private static String print(RawSchema schema) {
        return new DataFilePrinter().printTable(new Table(
                RawSchema.idOf(schema.tables().get(0)), schema.tables().get(0),
                TableMeta.EMPTY, Map.of()));
    }
}
