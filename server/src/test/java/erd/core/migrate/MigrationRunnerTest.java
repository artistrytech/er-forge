package erd.core.migrate;

import erd.core.fixtures.FixtureModels;
import erd.core.io.ProjectStore;
import erd.core.model.Manifest;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** schemaVersion の自動移行（Phase0 詳細設計 §6、T-15〜T-17）。 */
class MigrationRunnerTest {

    private final ProjectStore store = new ProjectStore();

    /** v0 → v1 のダミー移行: 全テーブルに tag "migrated" を付ける。 */
    private static final Migration V0_TO_V1 = new Migration() {
        @Override public int fromVersion() { return 0; }
        @Override public int toVersion() { return 1; }
        @Override public String description() { return "テスト移行（tag を付与）"; }
        @Override public ProjectModel apply(ProjectModel model) {
            List<Table> tables = new ArrayList<>();
            for (Table t : model.tables()) {
                TableMeta m = t.meta();
                List<String> tags = new ArrayList<>(m.tags());
                if (!tags.contains("migrated")) tags.add("migrated");
                tables.add(t.withMeta(new TableMeta(m.displayName(), tags, m.color(), m.notes(),
                        m.columns(), m.logicalUniques(), m.logicalForeignKeys(), m.relations(),
                        m.unknown())));
            }
            return new ProjectModel(model.manifest(), model.config(), model.dictionary(),
                    tables, model.diagrams());
        }
    };

    private static final Migration FAILING = new Migration() {
        @Override public int fromVersion() { return 0; }
        @Override public int toVersion() { return 1; }
        @Override public String description() { return "途中で失敗する移行"; }
        @Override public ProjectModel apply(ProjectModel model) {
            throw new IllegalStateException("simulated failure (disk full)");
        }
    };

    /** projectRoot/data に schemaVersion 付きのプロジェクト一式を書く。 */
    private void writeProject(Path projectRoot, int schemaVersion) {
        Manifest m = FixtureModels.manifest().withSchemaVersion(schemaVersion);
        ProjectModel model = new ProjectModel(m, FixtureModels.config(), FixtureModels.dictionary(),
                List.of(FixtureModels.usersTable(), FixtureModels.ordersTable(),
                        FixtureModels.organizationsTable()),
                List.of(FixtureModels.coreDiagram()));
        store.writeAll(projectRoot.resolve("data"), model);
    }

    private Map<String, byte[]> snapshot(Path dataDir) throws IOException {
        Map<String, byte[]> files = new LinkedHashMap<>();
        try (Stream<Path> walk = Files.walk(dataDir)) {
            for (Path p : walk.filter(Files::isRegularFile).sorted().toList()) {
                files.put(dataDir.relativize(p).toString().replace('\\', '/'), Files.readAllBytes(p));
            }
        }
        return files;
    }

    @Test
    @DisplayName("T-15: v0 のデータが自動移行され、schemaVersion 1 になり、バックアップが残る")
    void migrates(@TempDir Path root) {
        writeProject(root, 0);
        MigrationRunner runner = new MigrationRunner(store, List.of(V0_TO_V1), 1);

        MigrationRunner.Result result = runner.run(root);

        assertTrue(result.migrated());
        assertEquals(0, result.fromVersion());
        assertEquals(1, result.toVersion());
        assertEquals(1, result.descriptions().size());
        assertTrue(Files.isDirectory(result.backupDir()), "バックアップが残ること");
        assertTrue(Files.exists(result.backupDir().resolve("manifest.js")));

        Manifest after = store.readManifestOnly(root.resolve("data"));
        assertEquals(1, after.schemaVersion());
        Table users = store.read(root.resolve("data")).model().table("public.users").orElseThrow();
        assertTrue(users.meta().tags().contains("migrated"), "移行関数が適用されていること");
    }

    @Test
    @DisplayName("T-15: 現行バージョンなら何もしない")
    void noopWhenCurrent(@TempDir Path root) {
        writeProject(root, 1);
        MigrationRunner runner = new MigrationRunner(store, List.of(V0_TO_V1), 1);
        MigrationRunner.Result result = runner.run(root);
        assertEquals(false, result.migrated());
    }

    @Test
    @DisplayName("T-16: 移行の途中で失敗したら data/** が移行前と完全に同一")
    void restoresOnFailure(@TempDir Path root) throws IOException {
        writeProject(root, 0);
        Path dataDir = root.resolve("data");
        Map<String, byte[]> before = snapshot(dataDir);

        MigrationRunner runner = new MigrationRunner(store, List.of(FAILING), 1);
        assertThrows(IllegalStateException.class, () -> runner.run(root));

        Map<String, byte[]> after = snapshot(dataDir);
        assertEquals(before.keySet(), after.keySet(), "ファイル構成が変わっていないこと");
        for (String name : before.keySet()) {
            assertTrue(java.util.Arrays.equals(before.get(name), after.get(name)),
                    "バイト単位で同一であること: " + name);
        }
    }

    @Test
    @DisplayName("T-17: データがサーバーより新しい形式なら起動を中止し、データに触れない")
    void abortsOnNewerData(@TempDir Path root) throws IOException {
        writeProject(root, 2);
        Path dataDir = root.resolve("data");
        Map<String, byte[]> before = snapshot(dataDir);

        MigrationRunner runner = new MigrationRunner(store, List.of(V0_TO_V1), 1);
        NewerDataException e = assertThrows(NewerDataException.class, () -> runner.run(root));
        assertEquals(2, e.dataVersion());

        Map<String, byte[]> after = snapshot(dataDir);
        assertEquals(before.keySet(), after.keySet());
        for (String name : before.keySet()) {
            assertTrue(java.util.Arrays.equals(before.get(name), after.get(name)),
                    "データを一切書き換えないこと: " + name);
        }
        assertTrue(!Files.exists(root.resolve(".erd")), "バックアップも作らないこと");
    }

    @Test
    @DisplayName("移行は冪等（2回実行しても結果が同じ）")
    void idempotent(@TempDir Path root) throws IOException {
        writeProject(root, 0);
        MigrationRunner runner = new MigrationRunner(store, List.of(V0_TO_V1), 1);
        runner.run(root);
        Map<String, byte[]> first = snapshot(root.resolve("data"));

        // すでに v1 なので2回目は no-op
        MigrationRunner.Result second = runner.run(root);
        assertEquals(false, second.migrated());
        Map<String, byte[]> after = snapshot(root.resolve("data"));
        assertEquals(first.keySet(), after.keySet());
    }
}
