package erd.core.tools;

import erd.core.fixtures.FixtureModels;
import erd.core.fixtures.Json;
import erd.core.io.DataFilePrinter;
import erd.core.model.DiagramPage;
import erd.core.model.Table;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * golden fixture の再生成。出力を目視確認してコミットする（CI では実行しない）。
 * 使い方: gradle generateFixtures
 */
public final class GenerateFixtures {

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        Files.createDirectories(dir);
        DataFilePrinter printer = new DataFilePrinter();
        // model.json は正準形（.js をパースした結果）から生成する。
        // マップの並びはファイル上のソート順が正であり、モデル定義の挿入順ではない。
        erd.core.io.DataFileParser parser = new erd.core.io.DataFileParser();

        for (Table t : new Table[] {
                FixtureModels.usersTable(),
                FixtureModels.ordersTable(),
                FixtureModels.organizationsTable(),
                FixtureModels.escapeTable(),
                FixtureModels.unknownKeysTable(),
                FixtureModels.activeUsersView() }) {
            String base = t.schema().name();
            String js = printer.printTable(t);
            write(dir.resolve(base + ".table.js"), js);
            write(dir.resolve(base + ".table.model.json"),
                    Json.pretty(parser.parseTable(js).value()));
        }

        DiagramPage diagram = FixtureModels.coreDiagram();
        String diagramJs = printer.printDiagram(diagram);
        write(dir.resolve("core.diagram.js"), diagramJs);
        write(dir.resolve("core.diagram.model.json"),
                Json.pretty(parser.parseDiagram(diagramJs).value()));

        String manifestJs = printer.printManifest(FixtureModels.manifest());
        write(dir.resolve("manifest.js"), manifestJs);
        write(dir.resolve("manifest.model.json"),
                Json.pretty(parser.parseManifest(manifestJs).value()));
        write(dir.resolve("config.js"), printer.printConfig(FixtureModels.config()));
        write(dir.resolve("config.model.json"), Json.pretty(FixtureModels.config()));
        write(dir.resolve("dictionary.js"), printer.printDictionary(FixtureModels.dictionary()));
        write(dir.resolve("dictionary.model.json"), Json.pretty(FixtureModels.dictionary()));
        write(dir.resolve("index.js"), printer.printIndex(FixtureModels.indexModel()));

        System.out.println("fixtures written to " + dir.toAbsolutePath());
    }

    private static void write(Path file, String content) throws Exception {
        Files.write(file, content.getBytes(StandardCharsets.UTF_8));
        System.out.println("  " + file.getFileName());
    }
}
