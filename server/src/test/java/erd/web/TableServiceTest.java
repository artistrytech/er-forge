package erd.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import erd.core.io.DataFileParser;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import erd.core.model.Column;
import erd.core.model.LogicalType;
import erd.core.model.Manifest;
import erd.core.model.ProjectConfig;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import erd.core.model.UniqueConstraint;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TableServiceTest {

    private final ObjectMapper json = new ObjectMapper();
    private final TableService service = new TableService();
    private final DataFileParser parser = new DataFileParser();

    @TempDir
    Path tmp;

    private Path dataDir;

    @BeforeEach
    void setup() {
        dataDir = tmp.resolve("data");
        Table users = new Table("public.users",
                new TableSchema("users", "public", null,
                        List.of(new Column("id", "int4", LogicalType.INT, false),
                                new Column("email", "varchar(255)", LogicalType.STRING, false),
                                new Column("status", "varchar(20)", LogicalType.STRING, true)),
                        List.of("id"),
                        List.of(new UniqueConstraint("users_email_key", List.of("email"))),
                        List.of(), List.of(), Map.of()),
                TableMeta.EMPTY, Map.of());
        Table orders = new Table("public.orders",
                new TableSchema("orders", "public", null,
                        List.of(new Column("id", "int4", LogicalType.INT, false),
                                new Column("user_id", "int4", LogicalType.INT, true),
                                new Column("code", "varchar(20)", LogicalType.STRING, false)),
                        List.of("id"), List.of(), List.of(), List.of(), Map.of()),
                TableMeta.EMPTY, Map.of());
        Manifest manifest = new Manifest(SchemaVersions.CURRENT, "2026-07-13T00:00:00Z",
                new Manifest.Source("PostgreSQL", "16"), "config.js", "dictionary.js",
                Map.of(), List.of(), Map.of());
        new ProjectStore().writeAll(dataDir, new ProjectModel(manifest, ProjectConfig.EMPTY,
                erd.core.model.Dictionary.EMPTY, List.of(users, orders), List.of()));
    }

    private String hashOf(String rel) {
        return Hashes.sha256(dataDir.resolve(rel));
    }

    /** orders の完全な定義（machine-owned 部分は setup と同一）に meta を差し込んだ JSON。 */
    private String ordersJson(String metaJson) {
        return """
                {
                  "id": "public.orders", "name": "orders", "schema": "public",
                  "columns": [
                    { "name": "id", "type": "int4", "logicalType": "int", "nullable": false },
                    { "name": "user_id", "type": "int4", "logicalType": "int", "nullable": true },
                    { "name": "code", "type": "varchar(20)", "logicalType": "string", "nullable": false }
                  ],
                  "primaryKey": ["id"]%s
                }
                """.formatted(metaJson.isEmpty() ? "" : ",\n  \"meta\": " + metaJson);
    }

    private TableService.Outcome put(String tableId, String tableJson, String baseHash) throws Exception {
        var body = json.readTree("""
                { "baseHash": "%s", "table": %s }
                """.formatted(baseHash, tableJson));
        return service.put(dataDir, tableId, body);
    }

    // P T-4: 論理外部制約を保存すると index.js が再生成され、lfk エッジが現れる
    @Test
    void savingMetaRegeneratesIndexWithLogicalEdge() throws Exception {
        String meta = """
                {
                  "displayName": "注文",
                  "columns": { "user_id": { "displayName": "ユーザーID", "notes": "論理参照" } },
                  "logicalForeignKeys": [
                    { "name": "lfk_orders_user", "columns": ["user_id"],
                      "ref": { "table": "public.users", "columns": ["id"] } }
                  ],
                  "relations": { "lfk:lfk_orders_user": { "child": "1..N" } }
                }
                """;
        var outcome = put("public.orders", ordersJson(meta), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Ok.class, outcome);
        var ok = (TableService.Ok) outcome;
        assertTrue(ok.writtenFiles().containsKey("schema/public/orders.js"));
        assertTrue(ok.writtenFiles().containsKey("index.js"));

        Table saved = parser.parseTable(
                Files.readString(dataDir.resolve("schema/public/orders.js"), StandardCharsets.UTF_8)).value();
        assertEquals("注文", saved.meta().displayName());
        assertEquals("ユーザーID", saved.meta().columns().get("user_id").displayName());

        String index = Files.readString(dataDir.resolve("index.js"), StandardCharsets.UTF_8);
        assertTrue(index.contains("public.orders#lfk:lfk_orders_user"));
        assertTrue(index.contains("\"1..N\"")); // meta.relations の上書きが解決されている
    }

    // §8.4: baseHash 不一致なら1バイトも書かずに STALE
    @Test
    void staleBaseHashRejectsWrite() throws Exception {
        Path file = dataDir.resolve("schema/public/orders.js");
        byte[] before = Files.readAllBytes(file);

        var outcome = put("public.orders", ordersJson(""), "sha256:0000");

        assertInstanceOf(TableService.Stale.class, outcome);
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    // リネーム（id / name の変更）はこの API では受け付けない（O-03 §3 は後続フェーズ）
    @Test
    void renameIsRejected() throws Exception {
        String renamed = ordersJson("").replace("\"public.orders\"", "\"public.accounts\"")
                .replace("\"orders\"", "\"accounts\"");
        var outcome = put("public.orders", renamed, hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Invalid.class, outcome);
        assertEquals("RENAME_UNSUPPORTED", ((TableService.Invalid) outcome).errors().get(0).code());
    }

    // P-08 V-3: 参照先テーブルが存在しない → エラー。ファイルは書かれない
    @Test
    void missingRefTableIsError() throws Exception {
        Path file = dataDir.resolve("schema/public/orders.js");
        byte[] before = Files.readAllBytes(file);
        String meta = """
                { "logicalForeignKeys": [
                    { "name": "lfk_x", "columns": ["user_id"],
                      "ref": { "table": "public.nope", "columns": ["id"] } } ] }
                """;
        var outcome = put("public.orders", ordersJson(meta), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Invalid.class, outcome);
        var invalid = (TableService.Invalid) outcome;
        assertTrue(invalid.errors().stream()
                .anyMatch(i -> i.code().equals("NOT_FOUND") && i.path().contains("ref.table")));
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    // P-08 V-2 / V-5: 参照元カラムの存在・カラム数の一致
    @Test
    void columnErrorsAreReported() throws Exception {
        String meta = """
                {
                  "logicalUniques": [ { "name": "luk_a", "columns": ["nope"] } ],
                  "logicalForeignKeys": [
                    { "name": "lfk_a", "columns": ["user_id", "code"],
                      "ref": { "table": "public.users", "columns": ["id"] } } ]
                }
                """;
        var outcome = put("public.orders", ordersJson(meta), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Invalid.class, outcome);
        var invalid = (TableService.Invalid) outcome;
        assertTrue(invalid.errors().stream().anyMatch(i -> i.code().equals("NOT_FOUND")
                && i.path().contains("logicalUniques")));
        assertTrue(invalid.errors().stream().anyMatch(i -> i.code().equals("COUNT_MISMATCH")));
    }

    // P-08 V-6: 参照先が一意でないのは警告（保存はできる）
    @Test
    void nonUniqueRefIsWarning() throws Exception {
        String meta = """
                { "logicalForeignKeys": [
                    { "name": "lfk_status", "columns": ["code"],
                      "ref": { "table": "public.users", "columns": ["status"] } } ] }
                """;
        var outcome = put("public.orders", ordersJson(meta), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Ok.class, outcome);
        var ok = (TableService.Ok) outcome;
        assertTrue(ok.warnings().stream().anyMatch(i -> i.code().equals("NOT_UNIQUE")));
    }

    // P-11: meta.relations の値域はエラー、存在しない制約への言及は警告
    @Test
    void relationValueValidation() throws Exception {
        String meta = """
                { "relations": { "fk:nope": { "child": "2..N" } } }
                """;
        var outcome = put("public.orders", ordersJson(meta), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Invalid.class, outcome);
        var invalid = (TableService.Invalid) outcome;
        assertTrue(invalid.errors().stream().anyMatch(i -> i.code().equals("INVALID_VALUE")));
        assertTrue(invalid.warnings().stream().anyMatch(i -> i.code().equals("ORPHAN")));
    }

    // 前方互換: 未知キーは保存後も保持される（Phase0 V-4 と同じ規則が PUT にも効く）
    @Test
    void unknownKeysArePreserved() throws Exception {
        String withUnknown = ordersJson("").trim();
        withUnknown = withUnknown.substring(0, withUnknown.length() - 1)
                + ", \"futureKey\": { \"x\": 1 } }";
        var outcome = put("public.orders", withUnknown, hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Ok.class, outcome);
        String saved = Files.readString(dataDir.resolve("schema/public/orders.js"), StandardCharsets.UTF_8);
        assertTrue(saved.contains("futureKey"));
    }

    // 変更なしの PUT はファイルを書き換えない（監視イベントも出ない）
    @Test
    void noopPutDoesNotRewrite() throws Exception {
        String base = hashOf("schema/public/orders.js");
        var outcome = put("public.orders", ordersJson(""), base);

        assertInstanceOf(TableService.Ok.class, outcome);
        var ok = (TableService.Ok) outcome;
        assertEquals(base, ok.newHash());
        assertFalse(ok.writtenFiles().containsKey("schema/public/orders.js"));
    }

    @Test
    void unknownTableIsNotFound() throws Exception {
        assertInstanceOf(TableService.NotFound.class,
                put("public.nope", ordersJson(""), "x"));
        assertNull(service.baseHash(dataDir, "public.nope"));
    }

    @Test
    void baseHashMatchesFile() {
        assertEquals(hashOf("schema/public/users.js"), service.baseHash(dataDir, "public.users"));
    }
}
