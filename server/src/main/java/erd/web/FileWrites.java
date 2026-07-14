package erd.web;

import erd.core.index.IndexGenerator;
import erd.core.io.DataFilePrinter;
import erd.core.io.ProjectStore;
import erd.core.model.DiagramPage;
import erd.core.model.Manifest;
import erd.core.model.Table;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;

/** 書き込み API 共通のファイル出力（一時ファイル + ATOMIC_MOVE / index.js の再生成）。 */
final class FileWrites {

    private static final DataFilePrinter PRINTER = new DataFilePrinter();
    private static final IndexGenerator INDEX_GENERATOR = new IndexGenerator();
    private static final ProjectStore STORE = new ProjectStore();

    static void writeAtomic(Path target, String content) throws IOException {
        Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
        Files.write(tmp, content.getBytes(StandardCharsets.UTF_8));
        try {
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /** index.js を全体から再生成する。内容が変わったときのみ書き、そのハッシュを返す。 */
    static String regenerateIndex(Path dataDir, List<Table> tables, List<DiagramPage> diagrams)
            throws IOException {
        return regenerate(dataDir, "index.js",
                PRINTER.printIndex(INDEX_GENERATOR.generate(tables, diagrams)));
    }

    /**
     * manifest.js を再生成する（ページの追加 / 削除 / 改名 / 並び替え = I-01〜I-03）。
     * index.js と同様に派生ファイルであり、baseHash の検証対象にはしない。
     */
    static String regenerateManifest(Path dataDir, Manifest old, List<Table> tables,
                                     List<DiagramPage> diagrams) throws IOException {
        return regenerate(dataDir, "manifest.js",
                PRINTER.printManifest(STORE.deriveManifest(old, tables, diagrams)));
    }

    /** 内容が変わったときのみ書き、そのハッシュを返す（変化なしなら null）。 */
    private static String regenerate(Path dataDir, String name, String content) throws IOException {
        Path file = dataDir.resolve(name);
        String hash = Hashes.sha256(content.getBytes(StandardCharsets.UTF_8));
        if (Files.isRegularFile(file) && Hashes.sha256(file).equals(hash)) {
            return null;
        }
        writeAtomic(file, content);
        return hash;
    }

    private FileWrites() { }
}
