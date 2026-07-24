package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import erd.core.model.DriverConfig;
import erd.introspect.DriverCatalog;
import erd.introspect.DriverDownloader;
import erd.introspect.Drivers;
import erd.layout.AutoLayout;
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
    private final Revisions revisions = new Revisions();
    private final DiagramService diagrams = new DiagramService();
    private final AutoLayout layout = new AutoLayout();
    private final TableService tables = new TableService();
    private final DictionaryService dictionary = new DictionaryService();
    private final ConfigService config = new ConfigService();
    private final ConnectionStore connections = new ConnectionStore();
    private final IntrospectService introspect = new IntrospectService();
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
        throw new IllegalStateException("No available port found: " + basePort + "-" + (basePort + 19));
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

        // ページ管理（I-01〜I-03 / I-06）とレイアウト
        javalin.get("/__erd/diagrams/{id}", this::getDiagram);
        javalin.post("/__erd/diagrams", this::createDiagram);
        javalin.delete("/__erd/diagrams/{id}", this::deleteDiagram);
        javalin.patch("/__erd/diagrams/{id}", this::patchDiagram);
        javalin.post("/__erd/layout/auto", this::layoutAuto);

        javalin.get("/__erd/tables/{id}", this::getTable);
        javalin.put("/__erd/tables/{id}", this::putTable);
        javalin.get("/__erd/dictionary", this::getDictionary);
        javalin.put("/__erd/dictionary", this::putDictionary);
        javalin.get("/__erd/config", this::getConfig);
        javalin.put("/__erd/config", this::putConfig);

        // 逆生成（K-01〜K-14）
        javalin.get("/__erd/drivers", this::getDrivers);
        javalin.post("/__erd/drivers/download", this::postDriverDownload);
        javalin.get("/__erd/connection", this::getConnection);
        javalin.put("/__erd/connection", this::putConnection);
        javalin.post("/__erd/connection/test", this::testConnection);
        javalin.post("/__erd/introspect", this::postIntrospect);
        javalin.get("/__erd/introspect/{sessionId}", this::getIntrospect);
        javalin.post("/__erd/introspect/{sessionId}/plan", this::postIntrospectPlan);
        javalin.post("/__erd/introspect/apply", this::postIntrospectApply);

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

    // -------------------------------------------------------------- diagrams

    /** ページの baseHash（編集開始前の取得用）。データ本体は返さない（§4.3）。 */
    private void getDiagram(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        String hash = diagrams.baseHash(root.resolve("data"), ctx.pathParam("id"));
        if (hash == null) {
            ctx.status(404).json(Map.of("error", "not found"));
            return;
        }
        ctx.json(Map.of("baseHash", hash));
    }

    /**
     * レイアウトの差分保存（§4.4）およびページ名・表示順の変更（I-03）。baseHash が必須。
     */
    private void patchDiagram(Context ctx) throws Exception {
        writeDiagram(ctx, (dataDir, body) -> diagrams.patch(dataDir, ctx.pathParam("id"), body));
    }

    /** I-01: ページの追加。 */
    private void createDiagram(Context ctx) throws Exception {
        writeDiagram(ctx, diagrams::create);
    }

    /** I-02: ページの削除（スキーマ情報には影響しない）。 */
    private void deleteDiagram(Context ctx) throws Exception {
        writeDiagram(ctx, (dataDir, body) -> diagrams.delete(dataDir, ctx.pathParam("id"), body));
    }

    /** ページ書き込み系の共通処理（baseHash 検証は各 Service 内 → リビジョン払い出し）。 */
    private void writeDiagram(Context ctx,
                              java.util.function.BiFunction<Path, JsonNode, DiagramService.Outcome> op)
            throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = ctx.body().isEmpty() ? mapper.createObjectNode() : mapper.readTree(ctx.body());
        DiagramService.Outcome outcome = op.apply(root.resolve("data"), body);
        if (outcome instanceof DiagramService.NotFound) {
            ctx.status(404).json(Map.of("error", "not found"));
        } else if (outcome instanceof DiagramService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof DiagramService.Duplicate dup) {
            ctx.status(409).json(Map.of("code", "DUPLICATE_ID", "id", dup.id()));
        } else if (outcome instanceof DiagramService.Invalid invalid) {
            ctx.status(400).json(Map.of("code", "VALIDATION", "message", invalid.message()));
        } else if (outcome instanceof DiagramService.Ok ok) {
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ObjectNode res = mapper.createObjectNode();
            res.put("revision", revision);
            res.put("newHash", ok.newHash());
            // 何を書いたかを返す。ノードの追加 / 除去（I-04 / I-06）は index.js の
            // tables[].diagrams を、ページ名・表示順（I-03）は manifest.js を動かす。
            // 自分の書き込みは SSE では無視される（INV-3）ため、ここで伝えないと
            // ビューアの派生データ（未配置トレイ・所属ページ）が古いままになる
            var files = res.putArray("files");
            ok.writtenFiles().keySet().forEach(files::add);
            ctx.json(res);
        }
    }

    // -------------------------------------------------------- 自動レイアウト（H-07 / H-08）

    /**
     * ELK による座標計算。<b>書き込みをしない</b>（§9 の API 仕様）。
     * 既存ノードとの衝突回避・オフセットはビューア側の責務（H-08 は既存を1つも動かさない）。
     */
    private void layoutAuto(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        List<AutoLayout.Node> nodes = new java.util.ArrayList<>();
        for (JsonNode n : body.path("nodes")) {
            String id = n.path("id").asText("");
            if (!id.isEmpty()) {
                nodes.add(new AutoLayout.Node(id, n.path("w").asDouble(0), n.path("h").asDouble(0)));
            }
        }
        List<AutoLayout.Edge> edges = new java.util.ArrayList<>();
        for (JsonNode e : body.path("edges")) {
            String from = e.path("from").asText("");
            String to = e.path("to").asText("");
            if (!from.isEmpty() && !to.isEmpty()) {
                edges.add(new AutoLayout.Edge(from, to));
            }
        }
        ObjectNode res = mapper.createObjectNode();
        ObjectNode positions = res.putObject("positions");
        layout.layout(nodes, edges).forEach((id, pos) -> {
            var arr = positions.putArray(id);
            arr.add(pos[0]);
            arr.add(pos[1]);
        });
        ctx.json(res);
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

    /** テーブル1件の全文置換保存（O-08 / J-05 / §4.2）。baseHash が必須。 */
    private void putTable(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
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

    // ---------------------------------------------------- config（無視リスト / K-15）

    private void getConfig(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        var cfg = config.read(root.resolve("data"));
        ObjectNode res = mapper.createObjectNode();
        res.put("baseHash", config.baseHash(root.resolve("data")));
        var arr = res.putArray("ignoreTables");
        cfg.ignoreTables().forEach(arr::add);
        ctx.json(res);
    }

    /** 無視リストの更新（§9.4）。config.js を書き換えるのみで、スキーマには一切触れない。 */
    private void putConfig(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        ConfigService.Outcome outcome = config.put(root.resolve("data"), body);
        if (outcome instanceof ConfigService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof ConfigService.Invalid invalid) {
            ctx.status(400).json(Map.of("error", invalid.message()));
        } else if (outcome instanceof ConfigService.Ok ok) {
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ctx.json(Map.of("revision", revision, "newHash", ok.newHash()));
        }
    }

    // --------------------------------------------------------- 逆生成（K-01〜K-14）

    /**
     * K-01 / §7.2: ロード済みドライバ・既定カタログ・config.js のドライバ設定・未取得の一覧。
     *
     * <p>逆生成画面の入口で使う。{@code missing} が空でなければ画面側がダウンロードの確認を出す。
     */
    private void getDrivers(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        DriverConfig cfg = config.read(root.resolve("data")).drivers();
        String repo = cfg.mavenRepository() != null && !cfg.mavenRepository().isBlank()
                ? cfg.mavenRepository() : DriverCatalog.DEFAULT_MAVEN_REPOSITORY;

        ObjectNode res = mapper.createObjectNode();
        res.set("drivers", mapper.valueToTree(Drivers.loaded()));
        res.set("catalog", mapper.valueToTree(DriverCatalog.entries()));

        ObjectNode configured = res.putObject("configured");
        configured.put("mavenRepository", repo);
        ArrayNode arts = configured.putArray("artifacts");
        ArrayNode missing = res.putArray("missing");
        for (String coordinate : cfg.artifacts()) {
            arts.add(coordinate);
            var c = DriverDownloader.parse(coordinate);
            if (c != null && !Files.isRegularFile(driversDir().resolve(c.jarFileName()))) {
                missing.add(coordinate);
            }
        }
        ctx.json(res);
    }

    /**
     * §7.2: config.js のドライバ座標を Maven からダウンロードして {@code drivers/} に置き、登録する。
     *
     * <p>本文 {@code { mavenRepository?, artifacts: [coord...] }}。artifacts は「今ダウンロードする対象」
     * （通常は {@code missing}）。ダウンロード自体は破壊的でないが外部通信を伴うため、確認は画面側で取る。
     */
    private void postDriverDownload(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        JsonNode arts = body.path("artifacts");
        if (!arts.isArray() || arts.isEmpty()) {
            ctx.status(400).json(Map.of("error", "artifacts must be a non-empty array"));
            return;
        }
        String repo = body.hasNonNull("mavenRepository") ? body.get("mavenRepository").asText() : null;
        if (repo == null || repo.isBlank()) {
            DriverConfig cfg = config.read(root.resolve("data")).drivers();
            repo = cfg.mavenRepository();
        }
        DriverDownloader downloader = new DriverDownloader();
        ArrayNode results = mapper.createArrayNode();
        for (JsonNode n : arts) {
            DriverDownloader.Result r = downloader.download(repo, n.asText(""), driversDir());
            if (r.ok()) {
                Drivers.registerJar(driversDir().resolve(r.fileName()));
            }
            ObjectNode ro = results.addObject();
            ro.put("coordinate", r.coordinate());
            ro.put("ok", r.ok());
            ro.put("fileName", r.fileName());
            ro.put("message", r.message());
        }
        ObjectNode res = mapper.createObjectNode();
        res.set("results", results);
        res.set("drivers", mapper.valueToTree(Drivers.loaded()));
        ctx.json(res);
    }

    /** {@code drivers/}（Git 管理外。JDBC ドライバの jar 置き場。§7.2）。 */
    private Path driversDir() {
        return root.resolve("drivers");
    }

    /** K-05: 保存された接続設定（パスワードは明示的に保存した場合のみ含む）。 */
    private void getConnection(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        ctx.json(connections.forClient(erdDir()));
    }

    private void putConnection(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        if (body.path("clear").asBoolean(false)) {
            connections.delete(erdDir());
        } else {
            connections.save(erdDir(), body);
        }
        ctx.json(Map.of("ok", true));
    }

    /** K-04: 接続テスト（製品名・バージョン・ネームスペース一覧）。 */
    private void testConnection(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        try {
            ctx.json(introspect.test(mapper.readTree(ctx.body())));
        } catch (java.sql.SQLException e) {
            ctx.status(400).json(Map.of("code", "CONNECT_FAILED", "message", String.valueOf(e.getMessage())));
        }
    }

    /** K-07 → K-08: 逆生成を実行し、差分プレビューを返す（1バイトも書き込まない。INV-4）。 */
    private void postIntrospect(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        try {
            respond(ctx, introspect.preview(erdDir(), root.resolve("data"), mapper.readTree(ctx.body())));
        } catch (java.sql.SQLException e) {
            ctx.status(400).json(Map.of("code", "CONNECT_FAILED", "message", String.valueOf(e.getMessage())));
        }
    }

    /** プレビューの再取得（ブラウザのリロード対策）。失効時は 410。 */
    private void getIntrospect(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        respond(ctx, introspect.reload(erdDir(), root.resolve("data"),
                ctx.pathParam("sessionId"), List.of()));
    }

    /**
     * リネーム決定を反映したプランの再計算（DB へは再接続しない）。
     * 差分ロジックはサーバーの単一実装に集約し、UI 側に持たせない。
     */
    private void postIntrospectPlan(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        respond(ctx, introspect.reload(erdDir(), root.resolve("data"), ctx.pathParam("sessionId"),
                introspect.decisions(body.path("renameDecisions"))));
    }

    /**
     * K-11: 差分の適用。置換中は SSE の配信を抑止し、完了後に単一のリビジョンとして
     * まとめて通知する（§8.6。中間状態をビューアに読ませない）。
     */
    private void postIntrospectApply(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        IntrospectService.Outcome outcome;
        if (watcher != null) watcher.suppress(true);
        try {
            outcome = introspect.apply(erdDir(), root.resolve("data"), body);
        } finally {
            if (watcher != null) watcher.suppress(false);
        }
        if (outcome instanceof IntrospectService.Ok ok && !ok.writtenFiles().isEmpty()) {
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ObjectNode res = mapper.valueToTree(ok.body());
            res.put("revision", revision);
            broadcast(revision, ok.writtenFiles().keySet());
            ctx.json(res);
            return;
        }
        respond(ctx, outcome);
    }

    private void respond(Context ctx, IntrospectService.Outcome outcome) {
        if (outcome instanceof IntrospectService.Ok ok) {
            ctx.json(ok.body());
        } else if (outcome instanceof IntrospectService.Gone gone) {
            ctx.status(410).json(Map.of("code", "SESSION_EXPIRED", "message", gone.message()));
        } else if (outcome instanceof IntrospectService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE",
                    "currentFingerprint", stale.currentFingerprint(),
                    "message", "Files changed after the preview. Run the preview again."));
        } else if (outcome instanceof IntrospectService.Bad bad) {
            ctx.status(400).json(Map.of("code", bad.code(), "message", bad.message(),
                    "itemIds", bad.itemIds()));
        } else if (outcome instanceof IntrospectService.Failed failed) {
            ctx.status(500).json(Map.of("code", "APPLY_FAILED", "message", failed.message()));
        }
    }

    /** `.erd/`（Git 管理外。接続設定・バックアップ）。erd/ の親に置く（§3.3）。 */
    private Path erdDir() {
        Path parent = root.getParent();
        return parent != null ? parent.resolve(".erd") : root.resolve(".erd");
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
        System.out.println("Wrote sample data (" + tables + " tables): "
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
                    .result("index.html is not in the same directory as erd-server.jar.");
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
