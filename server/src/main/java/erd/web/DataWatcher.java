package erd.web;

import java.io.IOException;
import java.nio.file.FileSystems;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardWatchEventKinds;
import java.nio.file.WatchEvent;
import java.nio.file.WatchKey;
import java.nio.file.WatchService;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;

/**
 * data/** のファイル監視 → SSE 配信の入力（H-09 / §6）。
 *
 * <p>変更をデバウンスして1つの変更群にまとめ、内容ハッシュで自己書き込みに帰属できるか
 * 判定してから listener（SSE ブロードキャスト）へ渡す。listener には
 * {revision, files} が渡り、クライアントは自分の revision を無視する（INV-3）。
 */
public final class DataWatcher implements AutoCloseable {

    private static final long DEBOUNCE_MS = 250;

    /**
     * 抑止を解いてよくなるまでの待ち時間。デバウンス1回分では、抑止を解いた直後に
     * 「たった今自分で書いた（消した）分」が外部変更として配信されてしまうため、余裕を持たせる。
     */
    static final long SETTLE_MS = DEBOUNCE_MS * 4;

    private final Path dataDir;
    private final Revisions revisions;
    private final BiConsumer<String, Set<String>> listener; // (revision, relPaths)
    private final Thread thread;
    private volatile boolean closed;
    private volatile boolean suppressed;

    public DataWatcher(Path dataDir, Revisions revisions, BiConsumer<String, Set<String>> listener) {
        this.dataDir = dataDir;
        this.revisions = revisions;
        this.listener = listener;
        this.thread = new Thread(this::run, "erd-data-watcher");
        this.thread.setDaemon(true);
    }

    public void start() {
        thread.start();
    }

    /**
     * 複数ファイルに跨る書き込み（逆生成の適用。§8.6）の間、配信を抑止する。
     *
     * <p>1ファイルずつ置換すると「manifest だけ新しく schema は古い」中間状態が一瞬生まれる。
     * その隙間に監視 → SSE → 再読込が走ると、ビューアが壊れた状態を読む。抑止を解いたあと、
     * 呼び出し側が単一のリビジョンとしてまとめて通知する。
     */
    public void suppress(boolean value) {
        this.suppressed = value;
    }

    /**
     * 監視が拾い終わるのを待ってから抑止を解く（ブートストラップ・データリセット用）。
     *
     * <p>これらは書き込み後にクライアントがページごと読み込み直すため、SSE で伝える相手がいない。
     * それでも監視は変更を拾うので、抑止を早く解くと<b>リロード直後のタブに「外部の変更を反映しました」が
     * 出てしまう</b>（自分の操作なのに他人の変更に見える）。拾い切るまで抑止を保つ。
     */
    void settleThenResume() {
        try {
            Thread.sleep(SETTLE_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            suppressed = false;
        }
    }

    @Override
    public void close() {
        closed = true;
        thread.interrupt();
    }

    private void run() {
        try (WatchService ws = FileSystems.getDefault().newWatchService()) {
            // data/ がまだ無ければ（ブートストラップ前）現れるまで待つ
            while (!closed && !Files.isDirectory(dataDir)) {
                Thread.sleep(1000);
            }
            registerAll(ws, dataDir);
            Set<String> changed = new HashSet<>();
            while (!closed) {
                WatchKey key = ws.poll(changed.isEmpty() ? 60_000 : DEBOUNCE_MS, TimeUnit.MILLISECONDS);
                if (key == null) {
                    if (!changed.isEmpty()) {
                        emit(changed);
                        changed = new HashSet<>();
                    }
                    continue;
                }
                Path base = (Path) key.watchable();
                for (WatchEvent<?> ev : key.pollEvents()) {
                    if (ev.kind() == StandardWatchEventKinds.OVERFLOW) continue;
                    Path rel = (Path) ev.context();
                    Path abs = base.resolve(rel);
                    if (ev.kind() == StandardWatchEventKinds.ENTRY_CREATE && Files.isDirectory(abs)) {
                        registerAll(ws, abs); // 新しいサブディレクトリも監視する
                        continue;
                    }
                    String name = abs.getFileName().toString();
                    if (name.endsWith(".js")) {
                        changed.add(dataDir.relativize(abs).toString().replace('\\', '/'));
                    }
                }
                key.reset();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (IOException e) {
            System.err.println("Warning: Could not start file watching: " + e.getMessage());
        }
    }

    private void emit(Set<String> relPaths) {
        if (suppressed) return;
        Map<String, String> hashes = new LinkedHashMap<>();
        for (String rel : relPaths) {
            Path f = dataDir.resolve(rel);
            hashes.put(rel, Files.isRegularFile(f) ? Hashes.sha256(f) : null);
        }
        String self = revisions.attribute(hashes);
        String revision = self != null ? self : revisions.nextExternal();
        listener.accept(revision, relPaths);
    }

    private static void registerAll(WatchService ws, Path root) throws IOException {
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs)
                    throws IOException {
                dir.register(ws, StandardWatchEventKinds.ENTRY_CREATE,
                        StandardWatchEventKinds.ENTRY_MODIFY, StandardWatchEventKinds.ENTRY_DELETE);
                return FileVisitResult.CONTINUE;
            }
        });
    }
}
