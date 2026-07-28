package erd.core.io;

import erd.core.fixtures.FixtureDir;
import erd.core.model.DiagramPage;
import erd.core.model.Table;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * T-1: 往復同一（ファイル → 読み取り → 書き戻しでバイト単位一致。INV-1）
 * T-2: べき等（同じモデルを2回書いて同一。INV-2）
 * T-10: 未知キーの保持（V-4）
 */
class RoundTripTest {

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();

    @Test
    @DisplayName("T-1/T-2: 全 table fixture の往復がバイト一致し、2回出力しても同一")
    void tableRoundTrip() throws Exception {
        for (Path p : FixtureDir.glob(".table.js")) {
            String original = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
            Table t = parser.parseTable(original).value();
            String printed = printer.printTable(t);
            assertEquals(original, printed, "round-trip mismatch: " + p.getFileName());
            assertEquals(printed, printer.printTable(t), "not idempotent: " + p.getFileName());
        }
    }

    @Test
    @DisplayName("T-1/T-2: diagram fixture の往復")
    void diagramRoundTrip() throws Exception {
        for (Path p : FixtureDir.glob(".diagram.js")) {
            String original = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
            DiagramPage d = parser.parseDiagram(original).value();
            String printed = printer.printDiagram(d);
            assertEquals(original, printed, "round-trip mismatch: " + p.getFileName());
            assertEquals(printed, printer.printDiagram(d));
        }
    }

    @Test
    @DisplayName("T-1: manifest / config / dictionary の往復")
    void otherRoundTrip() {
        String manifest = FixtureDir.read("manifest.js");
        assertEquals(manifest, printer.printManifest(parser.parseManifest(manifest).value()));

        String config = FixtureDir.read("config.js");
        assertEquals(config, printer.printConfig(parser.parseConfig(config).value()));

        String dictionary = FixtureDir.read("dictionary.js");
        assertEquals(dictionary, printer.printDictionary(parser.parseDictionary(dictionary).value()));
    }

    @Test
    @DisplayName("既存の manifest.js にある generatedAt / source は、読み込んで書き戻すと消える")
    void generatedAtAndSourceAreDropped() {
        String legacy = """
                ERD.manifest({
                  schemaVersion: 1,
                  generatedAt: "2026-07-12T00:00:00Z",
                  source: { product: "PostgreSQL", version: "16.2" },
                  config: "config.js",
                  dictionary: "dictionary.js",
                });
                """;
        var manifest = parser.parseManifest(legacy).value();

        // 未知キーとして保持されてはならない（保持されると古い値が残り続ける）
        assertFalse(manifest.unknown().containsKey("generatedAt"));
        assertFalse(manifest.unknown().containsKey("source"));
        String printed = printer.printManifest(manifest);
        assertFalse(printed.contains("generatedAt"), printed);
        assertFalse(printed.contains("source"), printed);
        // 2回目以降は安定する（書き戻した結果がそのまま往復する）
        assertEquals(printed, printer.printManifest(parser.parseManifest(printed).value()));
    }

    @Test
    @DisplayName("T-10: 未知キーを含む fixture を読んで書き戻すと未知キーが保持される")
    void unknownKeysPreserved() {
        String original = FixtureDir.read("future.table.js");
        Table t = parser.parseTable(original).value();

        assertTrue(t.unknown().containsKey("futureFeature"), "table-level unknown key lost");
        assertTrue(t.schema().columns().get(0).unknown().containsKey("sensitivity"),
                "column-level unknown key lost");
        assertTrue(t.meta().unknown().containsKey("reviewedBy"), "meta-level unknown key lost");

        String printed = printer.printTable(t);
        assertEquals(original, printed);
        assertFalse(printed.isEmpty());
    }
}
