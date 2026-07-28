package erd.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import erd.core.io.DataFileParser;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import erd.core.model.DiagramPage;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
import erd.core.model.ProjectConfig;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import erd.core.model.Column;
import erd.core.model.LogicalType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DiagramServiceTest {

    private final ObjectMapper json = new ObjectMapper();
    private final DiagramService service = new DiagramService();
    private final DataFileParser parser = new DataFileParser();

    @TempDir
    Path tmp;

    private Path dataDir;

    @BeforeEach
    void setup() {
        dataDir = tmp.resolve("data");
        Table users = table("users");
        Table orders = table("orders");
        DiagramPage core = new DiagramPage("core", "コア", 1,
                Map.of("public.users", new NodeLayout(new Point(120, 80), 260, Map.of()),
                        "public.orders", new NodeLayout(new Point(520, 80), null, Map.of())),
                Map.of());
        Manifest manifest = new Manifest(SchemaVersions.CURRENT,
                new Manifest.Source("PostgreSQL", "16"), "config.js", "dictionary.js",
                Map.of(), List.of(), Map.of());
        new ProjectStore().writeAll(dataDir, new ProjectModel(manifest, ProjectConfig.EMPTY,
                erd.core.model.Dictionary.EMPTY, List.of(users, orders), List.of(core)));
    }

    private static Table table(String name) {
        return new Table("public." + name,
                new TableSchema(name, "public", null,
                        List.of(new Column("id", "int4", LogicalType.INT, false)),
                        List.of("id"), List.of(), List.of(), List.of(), Map.of()),
                TableMeta.EMPTY, Map.of());
    }

    private String hashOf(String rel) {
        return Hashes.sha256(dataDir.resolve(rel));
    }

    // T-8 / INV-5: baseHash 不一致なら1バイトも書かずに STALE
    @Test
    void staleBaseHashRejectsWrite() throws Exception {
        Path file = dataDir.resolve("diagrams/core.js");
        byte[] before = Files.readAllBytes(file);

        var body = json.readTree("""
                { "baseHash": "sha256:0000", "nodes": { "public.users": { "pos": [200, 200] } } }
                """);
        var outcome = service.patch(dataDir, "core", body);

        assertInstanceOf(DiagramService.Stale.class, outcome);
        assertEquals(Hashes.sha256(before), ((DiagramService.Stale) outcome).currentHash());
        org.junit.jupiter.api.Assertions.assertArrayEquals(before, Files.readAllBytes(file));
    }

    // T-2 / INV-2: 座標は 8px スナップ + 整数化。既存の w / 他ノードは保持される
    @Test
    void patchNormalizesAndMergesPartially() throws Exception {
        String base = hashOf("diagrams/core.js");
        var body = json.readTree("""
                { "baseHash": "%s", "nodes": { "public.users": { "pos": [203.7, 197] } } }
                """.formatted(base));
        var outcome = service.patch(dataDir, "core", body);

        assertInstanceOf(DiagramService.Ok.class, outcome);
        DiagramPage page = parser.parseDiagram(
                Files.readString(dataDir.resolve("diagrams/core.js"), StandardCharsets.UTF_8)).value();
        assertEquals(new Point(200, 200), page.nodes().get("public.users").pos());
        assertEquals(260, page.nodes().get("public.users").w());       // 送っていない w は保持
        assertEquals(new Point(520, 80), page.nodes().get("public.orders").pos()); // 触っていないノードは不変
    }

    // force: true は baseHash 検証をスキップする（409 ダイアログの「上書き保存」）
    @Test
    void forceSkipsHashCheck() throws Exception {
        var body = json.readTree("""
                { "baseHash": "sha256:0000", "force": true,
                  "nodes": { "public.users": { "pos": [200, 200] } } }
                """);
        assertInstanceOf(DiagramService.Ok.class, service.patch(dataDir, "core", body));
    }

    // null = ページから除去（I-06）。index.js の diagrams からも消える
    @Test
    void nullRemovesNodeAndRegeneratesIndex() throws Exception {
        String base = hashOf("diagrams/core.js");
        var body = json.readTree("""
                { "baseHash": "%s", "nodes": { "public.orders": null } }
                """.formatted(base));
        var outcome = service.patch(dataDir, "core", body);

        assertInstanceOf(DiagramService.Ok.class, outcome);
        DiagramPage page = parser.parseDiagram(
                Files.readString(dataDir.resolve("diagrams/core.js"), StandardCharsets.UTF_8)).value();
        assertNull(page.nodes().get("public.orders"));

        String index = Files.readString(dataDir.resolve("index.js"), StandardCharsets.UTF_8);
        assertTrue(index.contains("\"public.users\"") || index.contains("public.users"));
        assertFalse(index.lines().filter(l -> l.contains("public.orders"))
                .anyMatch(l -> l.contains("diagrams: [\"core\"]")));
        assertTrue(((DiagramService.Ok) outcome).writtenFiles().containsKey("index.js"));
    }

    // 変更なしのパッチ（同一座標）はファイルを書き換えない → 監視イベントも出ない
    @Test
    void noopPatchDoesNotRewrite() throws Exception {
        String base = hashOf("diagrams/core.js");
        var body = json.readTree("""
                { "baseHash": "%s", "nodes": { "public.users": { "pos": [120, 80], "w": 260 } } }
                """.formatted(base));
        var outcome = service.patch(dataDir, "core", body);

        assertInstanceOf(DiagramService.Ok.class, outcome);
        var ok = (DiagramService.Ok) outcome;
        assertEquals(base, ok.newHash());
        assertFalse(ok.writtenFiles().containsKey("diagrams/core.js"));
    }

    @Test
    void unknownDiagramIsNotFound() throws Exception {
        var body = json.readTree("{ \"baseHash\": \"x\" }");
        assertInstanceOf(DiagramService.NotFound.class, service.patch(dataDir, "nope", body));
        assertInstanceOf(DiagramService.NotFound.class, service.patch(dataDir, "../manifest", body));
    }

    // ------------------------------------------------------- ページ管理（I-01〜I-03）

    // I-01: 新規ページはファイルが作られ、manifest.js に追記される（既存ページは動かない）
    @Test
    void createAddsEmptyPageAndUpdatesManifest() throws Exception {
        var outcome = service.create(dataDir, json.readTree("""
                { "id": "billing", "title": "課金" }
                """));

        assertInstanceOf(DiagramService.Ok.class, outcome);
        var ok = (DiagramService.Ok) outcome;
        assertTrue(ok.writtenFiles().containsKey("diagrams/billing.js"));
        assertTrue(ok.writtenFiles().containsKey("manifest.js"));

        DiagramPage page = parser.parseDiagram(
                Files.readString(dataDir.resolve("diagrams/billing.js"), StandardCharsets.UTF_8)).value();
        assertEquals("課金", page.title());
        assertEquals(2, page.order());        // 既存の最大 order + 1
        assertTrue(page.nodes().isEmpty());

        Manifest manifest = new ProjectStore().readManifestOnly(dataDir);
        assertEquals(List.of("core", "billing"),
                manifest.diagrams().stream().map(Manifest.DiagramRef::id).toList());
    }

    // 既存ページを黙って潰さない
    @Test
    void createRejectsDuplicateAndBadId() throws Exception {
        assertInstanceOf(DiagramService.Duplicate.class,
                service.create(dataDir, json.readTree("{ \"id\": \"core\", \"title\": \"別\" }")));
        assertInstanceOf(DiagramService.Invalid.class,
                service.create(dataDir, json.readTree("{ \"id\": \"../evil\", \"title\": \"x\" }")));
        assertInstanceOf(DiagramService.Invalid.class,
                service.create(dataDir, json.readTree("{ \"id\": \"ok\", \"title\": \"  \" }")));
    }

    // I-02: ページを消してもスキーマ情報は残る（index.js の tables は変わらない）
    @Test
    void deleteRemovesPageButKeepsSchema() throws Exception {
        var outcome = service.delete(dataDir, "core",
                json.readTree("{ \"baseHash\": \"%s\" }".formatted(hashOf("diagrams/core.js"))));

        assertInstanceOf(DiagramService.Ok.class, outcome);
        var ok = (DiagramService.Ok) outcome;
        assertFalse(Files.exists(dataDir.resolve("diagrams/core.js")));
        assertNull(ok.writtenFiles().get("diagrams/core.js"));  // null = 削除の記録（SSE の自己判定）

        assertTrue(new ProjectStore().readManifestOnly(dataDir).diagrams().isEmpty());
        assertTrue(Files.exists(dataDir.resolve("schema/public/users.js")));
        // ページが消えたので、どのテーブルも未配置になる（K-12 の導出）
        String index = Files.readString(dataDir.resolve("index.js"), StandardCharsets.UTF_8);
        assertFalse(index.contains("diagrams: [\"core\"]"));
    }

    // 外部で編集されたページを黙って消さない（§8.4 の baseHash は削除にも効く）
    @Test
    void deleteRejectsStaleBaseHash() throws Exception {
        var outcome = service.delete(dataDir, "core", json.readTree("{ \"baseHash\": \"sha256:0000\" }"));
        assertInstanceOf(DiagramService.Stale.class, outcome);
        assertTrue(Files.exists(dataDir.resolve("diagrams/core.js")));
    }

    // I-03: ページ名・表示順の変更はページファイルと manifest.js の両方に反映される
    @Test
    void patchUpdatesTitleAndOrder() throws Exception {
        var outcome = service.patch(dataDir, "core", json.readTree("""
                { "baseHash": "%s", "title": "コアドメイン", "order": 5 }
                """.formatted(hashOf("diagrams/core.js"))));

        assertInstanceOf(DiagramService.Ok.class, outcome);
        DiagramPage page = parser.parseDiagram(
                Files.readString(dataDir.resolve("diagrams/core.js"), StandardCharsets.UTF_8)).value();
        assertEquals("コアドメイン", page.title());
        assertEquals(5, page.order());
        // 配置は巻き添えで消えない
        assertEquals(new Point(120, 80), page.nodes().get("public.users").pos());

        Manifest.DiagramRef ref = new ProjectStore().readManifestOnly(dataDir).diagrams().get(0);
        assertEquals("コアドメイン", ref.title());
        assertEquals(5, ref.order());
    }

    @Test
    void patchRejectsBlankTitle() throws Exception {
        var outcome = service.patch(dataDir, "core", json.readTree("""
                { "baseHash": "%s", "title": "  " }
                """.formatted(hashOf("diagrams/core.js"))));
        assertInstanceOf(DiagramService.Invalid.class, outcome);
    }

    // I-04: 未配置テーブルのページ追加（トレイ → キャンバス）。新規キーの追加として届く
    @Test
    void patchAddsNodeToPage() throws Exception {
        var outcome = service.delete(dataDir, "core",
                json.readTree("{ \"baseHash\": \"%s\" }".formatted(hashOf("diagrams/core.js"))));
        assertInstanceOf(DiagramService.Ok.class, outcome);
        assertInstanceOf(DiagramService.Ok.class,
                service.create(dataDir, json.readTree("{ \"id\": \"core\", \"title\": \"コア\" }")));

        var added = service.patch(dataDir, "core", json.readTree("""
                { "baseHash": "%s", "nodes": { "public.users": { "pos": [40, 40] } } }
                """.formatted(hashOf("diagrams/core.js"))));

        assertInstanceOf(DiagramService.Ok.class, added);
        DiagramPage page = parser.parseDiagram(
                Files.readString(dataDir.resolve("diagrams/core.js"), StandardCharsets.UTF_8)).value();
        assertEquals(new Point(40, 40), page.nodes().get("public.users").pos());
        // index.js の tables[].diagrams が追随する（未配置 → 配置済み）
        assertTrue(Files.readString(dataDir.resolve("index.js"), StandardCharsets.UTF_8)
                .contains("diagrams: [\"core\"]"));
    }
}
