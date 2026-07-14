package erd.core.io;

import erd.core.index.IndexGenerator;
import erd.core.model.DiagramPage;
import erd.core.model.Manifest;
import erd.core.model.ProjectModel;
import erd.core.model.Table;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * data/** の読み書き。
 *
 * <p>書き込みは全文を決定論的プリンタで再生成し、一時ファイル + ATOMIC_MOVE で置換する。
 * manifest.js と index.js は派生情報であり、書き込みのたびに必ず再生成する。
 */
public final class ProjectStore {

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();
    private final IndexGenerator indexGenerator = new IndexGenerator();

    public record LoadResult(ProjectModel model, List<String> warnings, Map<String, String> fileErrors) {}

    // ----------------------------------------------------------------- read

    public LoadResult read(Path dataDir) {
        List<String> warnings = new ArrayList<>();
        Map<String, String> fileErrors = new LinkedHashMap<>();

        Parsed<Manifest> manifest = parser.parseManifest(readFile(dataDir.resolve("manifest.js")));
        warnings.addAll(manifest.warnings());
        Manifest m = manifest.value();

        var config = erd.core.model.ProjectConfig.EMPTY;
        String configFile = m.config() == null ? "config.js" : m.config();
        if (Files.exists(dataDir.resolve(configFile))) {
            config = parser.parseConfig(readFile(dataDir.resolve(configFile))).value();
        }

        var dictionary = erd.core.model.Dictionary.EMPTY;
        String dictionaryFile = m.dictionary() == null ? "dictionary.js" : m.dictionary();
        if (Files.exists(dataDir.resolve(dictionaryFile))) {
            dictionary = parser.parseDictionary(readFile(dataDir.resolve(dictionaryFile))).value();
        }

        List<Table> tables = new ArrayList<>();
        for (Map.Entry<String, String> e : m.tables().entrySet()) {
            Path file = dataDir.resolve(e.getValue());
            try {
                Parsed<Table> t = parser.parseTable(readFile(file));
                warnings.addAll(t.warnings());
                tables.add(t.value());
            } catch (DataFileException | UncheckedIOException ex) {
                // ファイル単位のエラーとして記録し、該当テーブルは「欠損」として扱う（V-1 / A-05）
                fileErrors.put(e.getValue(), ex.getMessage());
            }
        }

        List<DiagramPage> diagrams = new ArrayList<>();
        for (Manifest.DiagramRef ref : m.diagrams()) {
            Path file = dataDir.resolve(ref.file());
            try {
                Parsed<DiagramPage> d = parser.parseDiagram(readFile(file));
                warnings.addAll(d.warnings());
                diagrams.add(d.value());
            } catch (DataFileException | UncheckedIOException ex) {
                fileErrors.put(ref.file(), ex.getMessage());
            }
        }

        return new LoadResult(new ProjectModel(m, config, dictionary, tables, diagrams),
                warnings, fileErrors);
    }

    /** manifest.js だけを読む（移行判定用。全体を読む前にバージョンを知る必要がある）。 */
    public Manifest readManifestOnly(Path dataDir) {
        return parser.parseManifest(readFile(dataDir.resolve("manifest.js"))).value();
    }

    // ---------------------------------------------------------------- write

    /** 全ファイルを決定論的プリンタで書き出す。manifest / index は必ず再生成する。 */
    public void writeAll(Path dataDir, ProjectModel model) {
        Map<String, String> files = renderAll(model);
        try {
            Files.createDirectories(dataDir);
            for (Map.Entry<String, String> e : files.entrySet()) {
                Path target = dataDir.resolve(e.getKey());
                Files.createDirectories(target.getParent());
                writeAtomic(target, e.getValue());
            }
            deleteStale(dataDir, files.keySet());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * manifest.js は派生ファイルである（テーブル・ページの一覧から一意に決まる）。
     * schemaVersion / generatedAt / source / 未知キーは既存の manifest から引き継ぐ。
     */
    public Manifest deriveManifest(Manifest old, List<Table> tables, List<DiagramPage> diagrams) {
        Map<String, String> tablePaths = new LinkedHashMap<>();
        for (Table t : tables.stream().sorted(Comparator.comparing(Table::id)).toList()) {
            tablePaths.put(t.id(), tablePath(t));
        }
        List<Manifest.DiagramRef> diagramRefs = diagrams.stream()
                .sorted(Comparator.comparingInt(DiagramPage::order).thenComparing(DiagramPage::id))
                .map(d -> new Manifest.DiagramRef(d.id(), "diagrams/" + d.id() + ".js", d.title(), d.order()))
                .toList();
        return new Manifest(old.schemaVersion(), old.generatedAt(), old.source(),
                "config.js", "dictionary.js", tablePaths, diagramRefs, old.unknown());
    }

    /** 相対パス → ファイル内容（書き込みはせず、レンダリングのみ）。 */
    public Map<String, String> renderAll(ProjectModel model) {
        Map<String, String> files = new LinkedHashMap<>();

        Manifest manifest = deriveManifest(model.manifest(), model.tables(), model.diagrams());

        files.put("manifest.js", printer.printManifest(manifest));
        files.put("config.js", printer.printConfig(model.config()));
        files.put("dictionary.js", printer.printDictionary(model.dictionary()));
        files.put("index.js", printer.printIndex(indexGenerator.generate(model.tables(), model.diagrams())));
        for (Table t : model.tablesSorted()) {
            files.put(tablePath(t), printer.printTable(t));
        }
        for (DiagramPage d : model.diagramsSorted()) {
            files.put("diagrams/" + d.id() + ".js", printer.printDiagram(d));
        }
        return files;
    }

    private String tablePath(Table t) {
        String schema = t.schema().schema();
        String dir = schema == null || schema.isEmpty() ? "schema" : "schema/" + schema;
        return dir + "/" + t.schema().name() + ".js";
    }

    private void writeAtomic(Path target, String content) throws IOException {
        Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
        Files.write(tmp, content.getBytes(StandardCharsets.UTF_8));
        try {
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (java.nio.file.AtomicMoveNotSupportedException e) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /** 期待セットに無い残置ファイル（削除されたテーブル・ページ）を除去する。 */
    private void deleteStale(Path dataDir, Set<String> expected) throws IOException {
        for (String sub : new String[] { "schema", "diagrams" }) {
            Path dir = dataDir.resolve(sub);
            if (!Files.isDirectory(dir)) continue;
            try (Stream<Path> walk = Files.walk(dir)) {
                List<Path> stale = walk
                        .filter(p -> Files.isRegularFile(p) && p.toString().endsWith(".js"))
                        .filter(p -> !expected.contains(relativize(dataDir, p)))
                        .toList();
                for (Path p : stale) {
                    Files.delete(p);
                }
            }
            // 空になったディレクトリを掃除する
            try (Stream<Path> walk = Files.walk(dir)) {
                List<Path> dirs = walk.filter(Files::isDirectory)
                        .sorted(Comparator.comparing((Path p) -> p.getNameCount()).reversed())
                        .toList();
                for (Path p : dirs) {
                    try (Stream<Path> children = Files.list(p)) {
                        if (children.findAny().isEmpty() && !p.equals(dir)) {
                            Files.delete(p);
                        }
                    }
                }
            }
        }
    }

    private static String relativize(Path base, Path p) {
        return base.relativize(p).toString().replace('\\', '/');
    }

    static String readFile(Path file) {
        try {
            String s = Files.readString(file, StandardCharsets.UTF_8);
            // BOM は許容して剥がす（書き込み側は決して付けない）
            if (!s.isEmpty() && s.charAt(0) == '\uFEFF') {
                s = s.substring(1);
            }
            return s;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
