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
        Manifest manifest = new Manifest(SchemaVersions.CURRENT, "2026-07-13T00:00:00Z",
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
}
