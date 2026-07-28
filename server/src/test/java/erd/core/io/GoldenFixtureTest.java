package erd.core.io;

import erd.core.fixtures.FixtureDir;
import erd.core.fixtures.FixtureModels;
import erd.core.fixtures.Json;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * golden fixture との一致。プリンタの出力が変わったら（意図的な変更でも）このテストが落ちる。
 * 意図的な変更のときは gradle generateFixtures で再生成し、差分をレビューしてコミットする。
 */
class GoldenFixtureTest {

    private final DataFilePrinter printer = new DataFilePrinter();
    private final DataFileParser parser = new DataFileParser();

    @Test
    @DisplayName("モデル → print が golden と一致する（プリンタのドリフト検知）")
    void printMatchesGolden() {
        assertEquals(FixtureDir.read("users.table.js"), printer.printTable(FixtureModels.usersTable()));
        assertEquals(FixtureDir.read("orders.table.js"), printer.printTable(FixtureModels.ordersTable()));
        assertEquals(FixtureDir.read("organizations.table.js"),
                printer.printTable(FixtureModels.organizationsTable()));
        assertEquals(FixtureDir.read("escape_test.table.js"), printer.printTable(FixtureModels.escapeTable()));
        assertEquals(FixtureDir.read("future.table.js"), printer.printTable(FixtureModels.unknownKeysTable()));
        assertEquals(FixtureDir.read("v_active_users.table.js"),
                printer.printTable(FixtureModels.activeUsersView()));
        assertEquals(FixtureDir.read("core.diagram.js"), printer.printDiagram(FixtureModels.coreDiagram()));
        assertEquals(FixtureDir.read("manifest.js"), printer.printManifest(FixtureModels.manifest()));
        assertEquals(FixtureDir.read("config.js"), printer.printConfig(FixtureModels.config()));
        assertEquals(FixtureDir.read("dictionary.js"), printer.printDictionary(FixtureModels.dictionary()));
        assertEquals(FixtureDir.read("index.js"), printer.printIndex(FixtureModels.indexModel()));
    }

    @Test
    @DisplayName("fixture.js → parse → model.json が golden と一致する（パーサの検証）")
    void parseMatchesModelJson() {
        assertEquals(FixtureDir.read("users.table.model.json"),
                Json.pretty(parser.parseTable(FixtureDir.read("users.table.js")).value()));
        assertEquals(FixtureDir.read("v_active_users.table.model.json"),
                Json.pretty(parser.parseTable(FixtureDir.read("v_active_users.table.js")).value()));
        assertEquals(FixtureDir.read("core.diagram.model.json"),
                Json.pretty(parser.parseDiagram(FixtureDir.read("core.diagram.js")).value()));
        assertEquals(FixtureDir.read("manifest.model.json"),
                Json.pretty(parser.parseManifest(FixtureDir.read("manifest.js")).value()));
    }
}
