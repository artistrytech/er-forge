package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.sse.SseClient;

import java.net.BindException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.stream.Stream;

/**
 * サーバーモードの Web 層。
 *
 * <p>データ本体は API で返さない（§4.3。読み込みは data/**.js の静的配信 + &lt;script&gt; 注入）。
 * API は書き込みと、書き込みに必要なメタ情報（baseHash・リビジョン）のためだけに存在する。
 */
public final class WebServer {

    private final Path root;      // erd/（index.html と data/ を含む）
    private final String token;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ProjectStore store = new ProjectStore();
    private final LockManager locks = new LockManager();
    private final Revisions revisions = new Revisions();
    private final DiagramService diagrams = new DiagramService();
    private final TableService tables = new TableService();
    private final DictionaryService dictionary = new DictionaryService();
    private final ConcurrentLinkedQueue<SseClient> sseClients = new ConcurrentLinkedQueue<>();
    private Javalin app;
    private DataWatcher watcher;

    public WebServer(Path root, String token) {
        this.root = root;
        this.token = token;
    }

    /** basePort から空きポートを探して起動し、実際のポートを返す（§8.1）。 */
    public int start(int basePort) {
        for (int port = basePort; port < basePort + 20; port++) {
            try {
                app = create();
                app.start("127.0.0.1", port);
                watcher = new DataWatcher(root.resolve("data"), revisions, this::broadcast);
                watcher.start();
                return port;
            } catch (RuntimeException e) {
                if (!isBindError(e)) throw e;
            }
        }
        throw new IllegalStateException("空きポートが見つかりません: " + basePort + "〜" + (basePort + 19));
    }

    public void stop() {
        if (watcher != null) watcher.close();
        if (app != null) app.stop();
    }

    private Javalin create() {
        Javalin javalin = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            cfg.jetty.defaultHost = "127.0.0.1";
        });

        javalin.get("/__erd/health", ctx ->
                ctx.json(Map.of("ok", true, "schemaVersion", SchemaVersions.CURRENT)));
        javalin.get("/__erd/project", this::project);
        javalin.post("/__erd/bootstrap", this::bootstrap);

        javalin.post("/__erd/lock", this::lockAcquire);
        javalin.put("/__erd/lock", this::lockHeartbeat);
        javalin.delete("/__erd/lock", this::lockRelease);
        // sendBeacon は POST しか送れないため、タブ閉じ用の別名を用意する（§2.1）
        javalin.post("/__erd/lock/release", this::lockRelease);

        javalin.patch("/__erd/diagrams/{id}", this::patchDiagram);

        javalin.get("/__erd/tables/{id}", this::getTable);
        javalin.put("/__erd/tables/{id}", this::putTable);
        javalin.get("/__erd/dictionary", this::getDictionary);
        javalin.put("/__erd/dictionary", this::putDictionary);

        javalin.sse("/__erd/events", this::sse);

        javalin.get("/", this::serveIndex);
        javalin.get("/index.html", this::serveIndex);
        javalin.get("/data/<path>", this::serveData);
        return javalin;
    }

    // --------------------------------------------------------------- project

    /** リビジョン・各ファイルの baseHash・schemaVersion・ブートストラップの要否（§8.2）。 */
    private void project(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        ObjectNode res = mapper.createObjectNode();
        res.put("schemaVersion", SchemaVersions.CURRENT);
        res.put("needsBootstrap", needsBootstrap());
        ObjectNode files = res.putObject("files");
        Path dataDir = root.resolve("data");
        if (Files.isDirectory(dataDir)) {
            try (Stream<Path> walk = Files.walk(dataDir)) {
                List<Path> list = walk
                        .filter(p -> Files.isRegularFile(p) && p.toString().endsWith(".js"))
                        .sorted()
                        .toList();
                for (Path p : list) {
                    files.put(dataDir.relativize(p).toString().replace('\\', '/'), Hashes.sha256(p));
                }
            }
        }
        ctx.json(res);
    }

    // ------------------------------------------------------------------ lock

    private void lockAcquire(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        boolean force = !ctx.body().isEmpty() && mapper.readTree(ctx.body()).path("force").asBoolean(false);
        LockManager.Acquire result = locks.acquire(force);
        if (!result.acquired()) {
            ctx.status(423).json(Map.of(
                    "code", "LOCKED",
                    "acquiredAt", String.valueOf(result.acquiredAt()),
                    "lastHeartbeat", String.valueOf(result.lastHeartbeat())));
            return;
        }
        ctx.json(Map.of("lockId", result.lockId(), "acquiredAt", String.valueOf(result.acquiredAt())));
    }

    private void lockHeartbeat(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        String lockId = ctx.body().isEmpty() ? null : mapper.readTree(ctx.body()).path("lockId").asText(null);
        if (!locks.heartbeat(lockId)) {
            ctx.status(409).json(Map.of("code", "LOCK_LOST"));
            return;
        }
        ctx.json(Map.of("ok", true));
    }

    private void lockRelease(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        String lockId = ctx.body().isEmpty() ? null : mapper.readTree(ctx.body()).path("lockId").asText(null);
        locks.release(lockId);
        ctx.json(Map.of("ok", true));
    }

    // -------------------------------------------------------------- diagrams

    /** レイアウトの差分保存（§4.4）。lockId と baseHash が必須。 */
    private void patchDiagram(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        if (!locks.isValid(body.path("lockId").asText(null))) {
            ctx.status(423).json(Map.of("code", "LOCK_LOST"));
            return;
        }
        DiagramService.Outcome outcome = diagrams.patch(root.resolve("data"), ctx.pathParam("id"), body);
        if (outcome instanceof DiagramService.NotFound) {
            ctx.status(404).json(Map.of("error", "not found"));
        } else if (outcome instanceof DiagramService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof DiagramService.Ok ok) {
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ctx.json(Map.of("revision", revision, "newHash", ok.newHash()));
        }
    }

    // ---------------------------------------------------- tables / dictionary

    /** 編集画面の初期値（O-03 §7）。データ本体は返さない（<script> 経路で読む）。baseHash のみ。 */
    private void getTable(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        String hash = tables.baseHash(root.resolve("data"), ctx.pathParam("id"));
        if (hash == null) {
            ctx.status(404).json(Map.of("error", "not found"));
            return;
        }
        ctx.json(Map.of("baseHash", hash));
    }

    /** テーブル1件の全文置換保存（O-08 / J-05 / §4.2）。lockId と baseHash が必須。 */
    private void putTable(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        if (!locks.isValid(body.path("lockId").asText(null))) {
            ctx.status(423).json(Map.of("code", "LOCK_LOST"));
            return;
        }
        TableService.Outcome outcome = tables.put(root.resolve("data"), ctx.pathParam("id"), body);
        if (outcome instanceof TableService.NotFound) {
            ctx.status(404).json(Map.of("error", "not found"));
        } else if (outcome instanceof TableService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof TableService.Invalid invalid) {
            ctx.status(422).json(Map.of(
                    "code", "VALIDATION",
                    "errors", invalid.errors().stream().map(TableService.Issue::toMap).toList(),
                    "warnings", invalid.warnings().stream().map(TableService.Issue::toMap).toList()));
        } else if (outcome instanceof TableService.Ok ok) {
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ctx.json(Map.of(
                    "revision", revision,
                    "newHash", ok.newHash(),
                    "warnings", ok.warnings().stream().map(TableService.Issue::toMap).toList()));
        }
    }

    private void getDictionary(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        ctx.json(Map.of("baseHash", dictionary.baseHash(root.resolve("data"))));
    }

    /** 辞書の一括更新（P-03 §2.4）。全体を1回の PUT で置換する。 */
    private void putDictionary(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        if (!locks.isValid(body.path("lockId").asText(null))) {
            ctx.status(423).json(Map.of("code", "LOCK_LOST"));
            return;
        }
        DictionaryService.Outcome outcome = dictionary.put(root.resolve("data"), body);
        if (outcome instanceof DictionaryService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof DictionaryService.Invalid invalid) {
            ctx.status(400).json(Map.of("error", invalid.message()));
        } else if (outcome instanceof DictionaryService.Ok ok) {
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ctx.json(Map.of("revision", revision, "newHash", ok.newHash()));
        }
    }

    // ------------------------------------------------------------------- SSE

    private void sse(SseClient client) {
        if (!authorized(client.ctx())) {
            client.close();
            return;
        }
        client.keepAlive();
        sseClients.add(client);
        client.onClose(() -> sseClients.remove(client));
    }

    /** ファイル監視からの変更通知を全クライアントへ配る（H-09）。 */
    private void broadcast(String revision, Set<String> files) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("revision", revision);
        var arr = payload.putArray("files");
        files.stream().sorted().forEach(arr::add);
        String json = payload.toString();
        for (SseClient client : sseClients) {
            client.sendEvent("change", json);
        }
    }

    // ------------------------------------------------------------- bootstrap

    /** 初回起動の初期化（§3.6）。既存データがある場合は実行できない（上書き事故を防ぐ）。 */
    private void bootstrap(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        String mode = ctx.body().isEmpty() ? "" : mapper.readTree(ctx.body()).path("mode").asText("");
        if (!"sample".equals(mode)) {
            ctx.status(400).json(Map.of("error", "unsupported mode: " + mode));
            return;
        }
        if (!needsBootstrap()) {
            ctx.status(409).json(Map.of("error", "already-initialized"));
            return;
        }
        int tables = SampleData.writeTo(root.resolve("data"));
        System.out.println("サンプルデータを書き出しました（" + tables + " テーブル）: "
                + root.resolve("data"));
        ctx.json(Map.of("ok", true, "tables", tables));
    }

    /** manifest.js が無い、またはテーブル0件のときのみブートストラップ可能（§3.6）。 */
    private boolean needsBootstrap() {
        Path manifest = root.resolve("data/manifest.js");
        if (!Files.exists(manifest)) return true;
        try {
            return store.readManifestOnly(root.resolve("data")).tables().isEmpty();
        } catch (RuntimeException e) {
            // 壊れた既存データは「存在する」として扱い、上書きしない
            return false;
        }
    }

    /** 書き込み API の共通ガード（§8.5 の最小形）: トークン一致 + Origin 検証。 */
    private boolean authorized(Context ctx) {
        String presented = ctx.queryParam("t");
        if (presented == null) presented = ctx.header("X-Erd-Token");
        if (!token.equals(presented)) return false;
        String origin = ctx.header("Origin");
        return origin == null
                || origin.startsWith("http://127.0.0.1:")
                || origin.startsWith("http://localhost:");
    }

    // ---------------------------------------------------------- static files

    private void serveIndex(Context ctx) throws Exception {
        Path index = root.resolve("index.html");
        if (!Files.isRegularFile(index)) {
            ctx.status(404).contentType("text/plain; charset=utf-8")
                    .result("index.html が erd-server.jar と同じディレクトリにありません。");
            return;
        }
        ctx.header("Cache-Control", "no-cache");
        ctx.contentType("text/html; charset=utf-8").result(Files.readAllBytes(index));
    }

    private void serveData(Context ctx) throws Exception {
        Path base = root.resolve("data").normalize();
        Path file = base.resolve(ctx.pathParam("path")).normalize();
        if (!file.startsWith(base) || !Files.isRegularFile(file)) {
            ctx.status(404).contentType("text/plain; charset=utf-8").result("not found");
            return;
        }
        // 書き込み後の再読込は ?v=<revision> 付きの <script> 再注入で行うため、キャッシュさせない（§4.3）
        ctx.header("Cache-Control", "no-cache");
        ctx.contentType(contentType(file)).result(Files.readAllBytes(file));
    }

    private static String contentType(Path file) {
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (name.endsWith(".json")) return "application/json; charset=utf-8";
        return "application/octet-stream";
    }

    private static boolean isBindError(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof BindException) return true;
        }
        return false;
    }
}
