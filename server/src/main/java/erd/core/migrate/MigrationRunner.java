package erd.core.migrate;

import erd.core.io.ProjectStore;
import erd.core.model.Manifest;
import erd.core.model.ProjectModel;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * サーバー起動時の自動移行（Phase0 詳細設計 §6.3）。
 *
 * <pre>
 * 1. manifest.js のみを先にパースして schemaVersion を読む
 * 2. 適用すべき移行の列を決める
 * 3. data/** を .erd/backup/<timestamp>/ にコピー
 * 4. 全ファイルをモデルとして読み込む
 * 5. 移行関数を順に適用
 * 6. schemaVersion を CURRENT にする
 * 7-8. index.js 再生成を含む全ファイルの書き出し（ProjectStore が行う）
 * 9. 失敗したらバックアップから完全復元し、起動を中止する
 * </pre>
 */
public final class MigrationRunner {

    private final ProjectStore store;
    private final List<Migration> migrations;
    private final int currentVersion;

    public MigrationRunner() {
        this(new ProjectStore(), SchemaVersions.MIGRATIONS, SchemaVersions.CURRENT);
    }

    /** テスト用に移行列と現行バージョンを注入できる。 */
    public MigrationRunner(ProjectStore store, List<Migration> migrations, int currentVersion) {
        this.store = store;
        this.migrations = migrations.stream()
                .sorted(Comparator.comparingInt(Migration::fromVersion))
                .toList();
        this.currentVersion = currentVersion;
    }

    public record Result(boolean migrated, int fromVersion, int toVersion,
                         List<String> descriptions, Path backupDir) {}

    /**
     * projectRoot は data/ を含むディレクトリ。
     *
     * @throws NewerDataException データがサーバーより新しい形式のとき（データには触れない）
     */
    public Result run(Path projectRoot) {
        Path dataDir = projectRoot.resolve("data");
        Manifest manifest = store.readManifestOnly(dataDir);
        int from = manifest.schemaVersion();

        if (from == currentVersion) {
            return new Result(false, from, from, List.of(), null);
        }
        if (from > currentVersion) {
            throw new NewerDataException(from, currentVersion);
        }

        List<Migration> plan = plan(from);
        Path backupDir = backup(projectRoot, dataDir);
        try {
            ProjectStore.LoadResult loaded = store.read(dataDir);
            if (!loaded.fileErrors().isEmpty()) {
                throw new IllegalStateException("Migration aborted because some files are invalid: "
                        + loaded.fileErrors());
            }
            ProjectModel model = loaded.model();
            List<String> descriptions = new ArrayList<>();
            for (Migration m : plan) {
                model = m.apply(model);
                descriptions.add("v" + m.fromVersion() + " → v" + m.toVersion() + ": " + m.description());
            }
            model = new ProjectModel(model.manifest().withSchemaVersion(currentVersion),
                    model.config(), model.dictionary(), model.tables(), model.diagrams());
            store.writeAll(dataDir, model);
            return new Result(true, from, currentVersion, descriptions, backupDir);
        } catch (RuntimeException e) {
            restore(backupDir, dataDir);
            throw e;
        }
    }

    private List<Migration> plan(int from) {
        List<Migration> plan = new ArrayList<>();
        int v = from;
        while (v < currentVersion) {
            final int fv = v;
            Migration next = migrations.stream()
                    .filter(m -> m.fromVersion() == fv)
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException(
                            "No migration found from v" + fv + " (server implementation error)"));
            plan.add(next);
            v = next.toVersion();
        }
        return plan;
    }

    private Path backup(Path projectRoot, Path dataDir) {
        String stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS"));
        Path backupDir = projectRoot.resolve(".erd").resolve("backup").resolve(stamp);
        copyTree(dataDir, backupDir);
        return backupDir;
    }

    private void restore(Path backupDir, Path dataDir) {
        deleteTree(dataDir);
        copyTree(backupDir, dataDir);
    }

    private static void copyTree(Path src, Path dst) {
        try (Stream<Path> walk = Files.walk(src)) {
            for (Path p : walk.toList()) {
                Path target = dst.resolve(src.relativize(p));
                if (Files.isDirectory(p)) {
                    Files.createDirectories(target);
                } else {
                    Files.createDirectories(target.getParent());
                    Files.copy(p, target, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static void deleteTree(Path dir) {
        if (!Files.exists(dir)) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.delete(p);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
