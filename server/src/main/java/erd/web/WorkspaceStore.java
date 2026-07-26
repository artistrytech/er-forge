package erd.web;

import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.model.Workspace;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * ワークスペースの一覧・作成・改名・削除（`erd/workspace-<id>/`）。
 *
 * <p><b>存在の正はフォルダの走査</b>で、{@code erd/workspaces.js} はその索引（表示名の置き場）である。
 * 静的モード（file://）はディレクトリを走査できないため、プルダウンに出す ID と表示名を
 * &lt;script&gt; 1本で読めるこのファイルに書き出しておく。走査結果と食い違ったら再生成する
 * （Git で pull されただけのワークスペースは、名前が分からないので ID を表示名にする）。
 */
final class WorkspaceStore {

    static final String REGISTRY = "workspaces.js";

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();

    // ------------------------------------------------------------------ paths

    /** {@code erd/workspace-<id>/}。 */
    static Path dir(Path root, String id) {
        return root.resolve(Workspace.folderName(id));
    }

    /** {@code erd/workspace-<id>/data/}。 */
    static Path dataDir(Path root, String id) {
        return dir(root, id).resolve("data");
    }

    /**
     * Git 管理外の個人データ（接続情報・バックアップ）。{@code .erd/workspace-<id>/}。
     * erd/ の親に置く（§3.3）。接続先はワークスペースごとに違うため分割は必須で、
     * バックアップも分けないと復元が別のワークスペースを壊す。
     */
    static Path privateDir(Path root, String id) {
        Path parent = root.getParent();
        Path base = parent != null ? parent.resolve(".erd") : root.resolve(".erd");
        return base.resolve(Workspace.folderName(id));
    }

    // ------------------------------------------------------------------- list

    /** 走査で見つかったワークスペースの ID（コードポイント順）。 */
    static List<String> scan(Path root) {
        if (!Files.isDirectory(root)) return List.of();
        try (Stream<Path> list = Files.list(root)) {
            return list.filter(Files::isDirectory)
                    .map(p -> Workspace.idFromFolder(p.getFileName().toString()))
                    .filter(id -> id != null)
                    .sorted(DataFilePrinter.CODEPOINT_ORDER)
                    .toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 走査結果 + レジストリの表示名。レジストリが古ければ書き直す。 */
    List<Workspace> list(Path root) {
        Map<String, String> names = registryNames(root);
        List<Workspace> out = new ArrayList<>();
        for (String id : scan(root)) {
            String name = names.get(id);
            out.add(new Workspace(id, name == null || name.isBlank() ? id : name));
        }
        syncRegistry(root, out);
        return out;
    }

    /** 1件だけ引く（存在しなければ null）。 */
    Workspace find(Path root, String id) {
        if (!Workspace.isValidId(id) || !Files.isDirectory(dir(root, id))) return null;
        String name = registryNames(root).get(id);
        return new Workspace(id, name == null || name.isBlank() ? id : name);
    }

    static boolean exists(Path root, String id) {
        return Workspace.isValidId(id) && Files.isDirectory(dir(root, id));
    }

    /** 大文字小文字を区別しない重複判定（Windows のパス仕様に合わせる）。 */
    static boolean conflicts(Path root, String id) {
        String norm = Workspace.normalizeId(id);
        return scan(root).stream().anyMatch(existing -> Workspace.normalizeId(existing).equals(norm));
    }

    // ---------------------------------------------------------------- mutate

    /** 空のワークスペースを作る（data/ だけを掘る。中身の初期化はブートストラップ）。 */
    Workspace create(Path root, String id, String name) {
        try {
            Files.createDirectories(dataDir(root, id));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        Workspace created = new Workspace(id, name);
        List<Workspace> all = new ArrayList<>(list(root));
        all.removeIf(w -> w.id().equals(id));
        all.add(created);
        writeRegistry(root, all);
        return created;
    }

    /**
     * ID・表示名の変更。ID を変えるとフォルダ名も変わる（Git 上は削除＋追加の差分になる）。
     * 個人データ（{@code .erd/workspace-<id>/}）も一緒に移す。
     */
    Workspace rename(Path root, String oldId, String newId, String newName) {
        if (!oldId.equals(newId)) {
            try {
                Files.move(dir(root, oldId), dir(root, newId));
                Path oldPrivate = privateDir(root, oldId);
                if (Files.isDirectory(oldPrivate)) {
                    Files.createDirectories(privateDir(root, newId).getParent());
                    Files.move(oldPrivate, privateDir(root, newId));
                }
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
        Workspace renamed = new Workspace(newId, newName);
        List<Workspace> all = new ArrayList<>(list(root));
        all.removeIf(w -> w.id().equals(oldId) || w.id().equals(newId));
        all.add(renamed);
        writeRegistry(root, all);
        return renamed;
    }

    /** ワークスペースを丸ごと削除する（個人データも消す）。 */
    void delete(Path root, String id) {
        try {
            deleteTree(dir(root, id));
            deleteTree(privateDir(root, id));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        List<Workspace> all = new ArrayList<>(list(root));
        all.removeIf(w -> w.id().equals(id));
        writeRegistry(root, all);
    }

    static void deleteTree(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            List<Path> paths = walk.sorted(Comparator.reverseOrder()).toList();
            for (Path p : paths) {
                Files.deleteIfExists(p);
            }
        }
    }

    // -------------------------------------------------------------- registry

    private Map<String, String> registryNames(Path root) {
        Path file = root.resolve(REGISTRY);
        Map<String, String> names = new LinkedHashMap<>();
        if (!Files.isRegularFile(file)) return names;
        try {
            for (Workspace w : parser.parseWorkspaces(Files.readString(file, StandardCharsets.UTF_8)).value()) {
                names.put(w.id(), w.name());
            }
        } catch (IOException | RuntimeException e) {
            // 壊れたレジストリで起動を止めない（走査結果から作り直せる）
            return new LinkedHashMap<>();
        }
        return names;
    }

    /** 走査結果と内容が違うときだけ書く（無用な mtime 変化・Git 差分を出さない）。 */
    private void syncRegistry(Path root, List<Workspace> workspaces) {
        Path file = root.resolve(REGISTRY);
        String content = printer.printWorkspaces(workspaces);
        try {
            if (Files.isRegularFile(file)
                    && content.equals(Files.readString(file, StandardCharsets.UTF_8))) {
                return;
            }
            FileWrites.writeAtomic(file, content);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private void writeRegistry(Path root, List<Workspace> workspaces) {
        syncRegistry(root, workspaces);
    }
}
