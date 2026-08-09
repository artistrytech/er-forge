package erd.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import erd.core.io.DataFileParser;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import erd.core.model.Column;
import erd.core.model.DiagramPage;
import erd.core.model.EdgeLayout;
import erd.core.model.LogicalType;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
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
        // ビュー（K-16）。スキーマは読み取り専用で、meta だけ編集できる
        Table view = new Table("public.v_users",
                new TableSchema("v_users", "public", "VIEW", null,
                        List.of(new Column("id", "int4", LogicalType.INT, true),
                                new Column("email", "varchar(255)", LogicalType.STRING, true)),
                        List.of(), List.of(), List.of(), List.of(), Map.of()),
                TableMeta.EMPTY, Map.of());
        Manifest manifest = new Manifest(SchemaVersions.CURRENT,
                "config.js", "dictionary.js",
                Map.of(), List.of(), Map.of());
        new ProjectStore().writeAll(dataDir, new ProjectModel(manifest, ProjectConfig.EMPTY,
                erd.core.model.Dictionary.EMPTY, List.of(users, orders, view), List.of()));
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

    // P-12: タグは保存前に正規化される（前後空白・空要素・重複を落とす。重複は大小無視）
    @Test
    void tagsAreNormalizedOnSave() throws Exception {
        String meta = """
                {
                  "tags": ["  core ", "", "Core", "廃止"],
                  "columns": { "code": { "tags": ["legacy", "legacy"] } }
                }
                """;
        var outcome = put("public.orders", ordersJson(meta), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Ok.class, outcome);
        Table saved = parser.parseTable(
                Files.readString(dataDir.resolve("schema/public/orders.js"), StandardCharsets.UTF_8)).value();
        assertEquals(List.of("core", "廃止"), saved.meta().tags());
        assertEquals(List.of("legacy"), saved.meta().columns().get("code").tags());
    }

    // P-12: 区切り文字・空白を含むタグ、長すぎるタグはエラー（黙って1件のタグにしない）
    @Test
    void invalidTagIsError() throws Exception {
        var outcome = put("public.orders", ordersJson("""
                { "tags": ["core, auth"] }
                """), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Invalid.class, outcome);
        var errors = ((TableService.Invalid) outcome).errors();
        assertEquals("meta.tags[0]", errors.get(0).path());
        assertEquals("TAG_WHITESPACE", errors.get(0).code());
    }

    // P-13: 色は既知トークンのみ。任意の hex は受け付けない
    @Test
    void unknownColorIsError() throws Exception {
        var outcome = put("public.orders", ordersJson("""
                { "color": "#ff0000" }
                """), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Invalid.class, outcome);
        var errors = ((TableService.Invalid) outcome).errors();
        assertEquals("meta.color", errors.get(0).path());
        assertEquals("UNKNOWN_COLOR", errors.get(0).code());
    }

    // P-13: 色は index.js にも載る（ER図はテーブルファイルを読まずにノードを描くため）
    @Test
    void colorIsWrittenToIndex() throws Exception {
        String meta = """
                { "color": "muted", "columns": { "code": { "color": "red" } } }
                """;
        var outcome = put("public.orders", ordersJson(meta), hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Ok.class, outcome);
        String index = Files.readString(dataDir.resolve("index.js"), StandardCharsets.UTF_8);
        assertTrue(index.contains("id: \"public.orders\""));
        assertTrue(index.contains("color: \"muted\""));
        // カラムの色は index には載せない（カラムを描く画面は必ずテーブルを読み込んでいる）
        assertFalse(index.contains("\"red\""));
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

    // ------------------------------------------------------------ 削除（J-02）

    private TableService.Outcome delete(String tableId, String baseHash) throws Exception {
        return service.delete(dataDir, tableId,
                json.readTree("{ \"baseHash\": \"%s\" }".formatted(baseHash)));
    }

    // J-02: スキーマファイルを消し、manifest.js / index.js から落とす
    @Test
    void deleteRemovesFileAndDerivedEntries() throws Exception {
        var outcome = delete("public.orders", hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Ok.class, outcome);
        var ok = (TableService.Ok) outcome;
        assertTrue(ok.writtenFiles().containsKey("schema/public/orders.js"));
        assertNull(ok.writtenFiles().get("schema/public/orders.js"), "削除は null で記録する");
        assertTrue(ok.writtenFiles().containsKey("manifest.js"));
        assertTrue(ok.writtenFiles().containsKey("index.js"));

        assertFalse(Files.exists(dataDir.resolve("schema/public/orders.js")));
        assertTrue(Files.exists(dataDir.resolve("schema/public/users.js")), "他テーブルは残る");

        String manifest = Files.readString(dataDir.resolve("manifest.js"), StandardCharsets.UTF_8);
        assertFalse(manifest.contains("public.orders"));
        assertTrue(manifest.contains("public.users"));
        String index = Files.readString(dataDir.resolve("index.js"), StandardCharsets.UTF_8);
        assertFalse(index.contains("public.orders"));
        assertNull(service.baseHash(dataDir, "public.orders"));
    }

    // J-02: 参照していた制約は自動削除しない（他テーブルを勝手に書き換えない。§6.2）
    @Test
    void deleteKeepsReferencesInOtherTables() throws Exception {
        String meta = """
                { "logicalForeignKeys": [
                    { "name": "lfk_orders_user", "columns": ["user_id"],
                      "ref": { "table": "public.users", "columns": ["id"] } } ] }
                """;
        assertInstanceOf(TableService.Ok.class,
                put("public.orders", ordersJson(meta), hashOf("schema/public/orders.js")));

        assertInstanceOf(TableService.Ok.class,
                delete("public.users", hashOf("schema/public/users.js")));

        Table orders = parser.parseTable(Files.readString(
                dataDir.resolve("schema/public/orders.js"), StandardCharsets.UTF_8)).value();
        assertEquals("public.users", orders.meta().logicalForeignKeys().get(0).ref().table());
        // 参照先を失ったリレーションは索引で dangling として残る（M-04 で検出させる）
        String index = Files.readString(dataDir.resolve("index.js"), StandardCharsets.UTF_8);
        assertTrue(index.contains("dangling: true"));
    }

    /** ノード削除のテスト用に、対象テーブルを配置した ER図ページを1枚用意する。 */
    private void writeDiagramPage() {
        ProjectStore ps = new ProjectStore();
        ProjectStore.LoadResult loaded = ps.read(dataDir);
        DiagramPage page = new DiagramPage("core", "コア", 1,
                Map.of("public.orders", new NodeLayout(new Point(0, 0)),
                        "public.users", new NodeLayout(new Point(200, 0))),
                Map.of("public.orders#fk:orders_user_fkey", new EdgeLayout(List.of(new Point(8, 8))),
                        "public.users#fk:users_org_fkey", new EdgeLayout(List.of(new Point(16, 16)))));
        ps.writeAll(dataDir, new ProjectModel(loaded.model().manifest(), loaded.model().config(),
                loaded.model().dictionary(), loaded.model().tables(), List.of(page)));
    }

    // J-02 既定: ER図のノードは残る（孤児ノード。K-13）
    @Test
    void deleteKeepsDiagramNodesByDefault() throws Exception {
        writeDiagramPage();

        var outcome = delete("public.orders", hashOf("schema/public/orders.js"));

        assertInstanceOf(TableService.Ok.class, outcome);
        assertFalse(((TableService.Ok) outcome).writtenFiles().containsKey("diagrams/core.js"));
        String page = Files.readString(dataDir.resolve("diagrams/core.js"), StandardCharsets.UTF_8);
        assertTrue(page.contains("\"public.orders\":"));
    }

    // J-02 選択時: ノードと、そのテーブルが持つエッジだけを全ページから取り除く
    @Test
    void deleteRemovesDiagramNodesWhenAsked() throws Exception {
        writeDiagramPage();

        var outcome = service.delete(dataDir, "public.orders", json.readTree("""
                { "baseHash": "%s", "removeNodes": true }
                """.formatted(hashOf("schema/public/orders.js"))));

        assertInstanceOf(TableService.Ok.class, outcome);
        assertTrue(((TableService.Ok) outcome).writtenFiles().containsKey("diagrams/core.js"));
        String page = Files.readString(dataDir.resolve("diagrams/core.js"), StandardCharsets.UTF_8);
        assertFalse(page.contains("\"public.orders\""), "ノードと自分のエッジは消える");
        assertTrue(page.contains("\"public.users\":"), "他テーブルのノードは残る");
        assertTrue(page.contains("public.users#fk:users_org_fkey"), "他テーブルのエッジは触らない");
    }

    // §8.4 / INV-5: baseHash 不一致ならファイルを消さない
    @Test
    void staleBaseHashRejectsDelete() throws Exception {
        var outcome = delete("public.orders", "sha256:0000");

        assertInstanceOf(TableService.Stale.class, outcome);
        assertTrue(Files.exists(dataDir.resolve("schema/public/orders.js")));
    }

    @Test
    void deleteUnknownTableIsNotFound() throws Exception {
        assertInstanceOf(TableService.NotFound.class, delete("public.nope", "x"));
    }

    // ------------------------------------------------------------ ビュー（K-16 / O-10）

    /** ビューの完全な定義（machine-owned 部分は setup と同一）に meta を差し込んだ JSON。 */
    private String viewJson(String columnsJson, String metaJson) {
        return """
                {
                  "id": "public.v_users", "name": "v_users", "schema": "public", "kind": "VIEW",
                  "columns": %s%s
                }
                """.formatted(columnsJson, metaJson.isEmpty() ? "" : ",\n  \"meta\": " + metaJson);
    }

    private static final String VIEW_COLUMNS = """
            [
                    { "name": "id", "type": "int4", "logicalType": "int", "nullable": true },
                    { "name": "email", "type": "varchar(255)", "logicalType": "string", "nullable": true }
                  ]""";

    @Test
    void viewMetaCanBeEdited() throws Exception {
        String meta = """
                { "displayName": "ユーザービュー", "tags": ["core"],
                  "columns": { "email": { "displayName": "メール" } } }
                """;
        var outcome = put("public.v_users", viewJson(VIEW_COLUMNS, meta),
                hashOf("schema/public/v_users.js"));

        assertInstanceOf(TableService.Ok.class, outcome);
        Table saved = parser.parseTable(Files.readString(
                dataDir.resolve("schema/public/v_users.js"), StandardCharsets.UTF_8)).value();
        assertEquals("ユーザービュー", saved.meta().displayName());
        assertEquals("VIEW", saved.schema().kind(), "meta の保存で kind が失われてはならない");

        String index = Files.readString(dataDir.resolve("index.js"), StandardCharsets.UTF_8);
        assertTrue(index.contains("kind: \"VIEW\""));
    }

    @Test
    void viewIsEditedLikeATable() throws Exception {
        // 種別による拒否は持たない（K-16 詳細設計 §7）。編集画面が扱うのは meta だけであり、
        // ビューをテーブルと別扱いにすると論理名・タグ・注記まで編集できなくなる
        String withExtraColumn = """
                [
                    { "name": "id", "type": "int4", "logicalType": "int", "nullable": true },
                    { "name": "email", "type": "varchar(255)", "logicalType": "string", "nullable": true },
                    { "name": "added", "type": "int4", "logicalType": "int", "nullable": true }
                  ]""";
        assertInstanceOf(TableService.Ok.class,
                put("public.v_users", viewJson(withExtraColumn, ""),
                        hashOf("schema/public/v_users.js")));
    }
}
