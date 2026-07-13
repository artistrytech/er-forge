package erd.web;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * 適用前バックアップ（§8.5 / K-11 §6.4）。{@code .erd/backup/<timestamp>/} に data/** の全体を
 * コピーし、直近3世代だけ残す。Git 管理外。
 *
 * <p>これは INV-5（全ファイルが成功するか、1ファイルも変わらないか）の最後の砦である。
 * 書き込みの途中で失敗した場合、ここから復元して適用前の状態に完全に戻す（T-7）。
 */
final class Backups {

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");
    private static final int KEEP = 3;

    /** data/** を .erd/backup/<timestamp>/ にコピーし、そのディレクトリを返す。 */
    static Path create(Path erdDir, Path dataDir) throws IOException {
        Path root = erdDir.resolve("backup");
        Files.createDirectories(root);
        Path dest = root.resolve(LocalDateTime.now().format(STAMP));
        // 同一秒内の再実行に備えて衝突を避ける
        int suffix = 1;
        while (Files.exists(dest)) {
            dest = root.resolve(LocalDateTime.now().format(STAMP) + "-" + suffix++);
        }
        copyTree(dataDir, dest);
        rotate(root);
        return dest;
    }

    /** バックアップから data/** を完全に復元する（適用前の状態に戻す）。 */
    static void restore(Path backupDir, Path dataDir) throws IOException {
        deleteTree(dataDir);
        copyTree(backupDir, dataDir);
    }

    private static void copyTree(Path from, Path to) throws IOException {
        if (!Files.isDirectory(from)) return;
        Files.createDirectories(to);
        try (Stream<Path> walk = Files.walk(from)) {
            List<Path> paths = walk.toList();
            for (Path p : paths) {
                Path target = to.resolve(from.relativize(p).toString());
                if (Files.isDirectory(p)) {
                    Files.createDirectories(target);
                } else {
                    Files.createDirectories(target.getParent());
                    Files.copy(p, target, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
    }

    private static void deleteTree(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        Files.walkFileTree(dir, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path d, IOException e) throws IOException {
                if (e != null) throw e;
                if (!d.equals(dir)) Files.delete(d);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void rotate(Path backupRoot) throws IOException {
        try (Stream<Path> list = Files.list(backupRoot)) {
            List<Path> dirs = list.filter(Files::isDirectory)
                    .sorted(Comparator.comparing((Path p) -> p.getFileName().toString()).reversed())
                    .toList();
            for (int i = KEEP; i < dirs.size(); i++) {
                deleteTree(dirs.get(i));
            }
        }
    }

    private Backups() { }
}
