package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import erd.core.model.DriverConfig;
import erd.core.model.Workspace;
import erd.introspect.DriverCatalog;
import erd.introspect.DriverDownloader;
import erd.introspect.Drivers;
import erd.layout.AutoLayout;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.sse.SseClient;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.BindException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.stream.Stream;

/**
 * サーバーモードの Web 層。
 *
 * <p>データ本体は API で返さない（§4.3。読み込みは workspace-&lt;id&gt;/data/**.js の静的配信 +
 * &lt;script&gt; 注入）。API は書き込みと、書き込みに必要なメタ情報（baseHash・リビジョン）のためだけに存在する。
 *
 * <p>ワークスペース（マルチデータベース構成の単位）ごとにデータが分かれるため、
 * データを触る API はすべて {@code /__erd/w/<id>/...} の下にある。ワークスペースに属さないのは
 * 疎通確認・ワークスペース管理・JDBC ドライバ設定（全ワークスペース共通）・SSE・自動レイアウト。
 */
public final class WebServer {

    private final Path root;      // erd/（index.html と workspace-*/ を含む）
    private final String token;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ProjectStore store = new ProjectStore();
    private final DiagramService diagrams = new DiagramService();
    private final AutoLayout layout = new AutoLayout();
    private final TableService tables = new TableService();
    private final DictionaryService dictionary = new DictionaryService();
    private final ConfigService config = new ConfigService();
    private final ConnectionStore connections = new ConnectionStore();
    private final IntrospectService introspect = new IntrospectService();
    private final WorkspaceStore workspaces = new WorkspaceStore();
    private final ConcurrentLinkedQueue<SseClient> sseClients = new ConcurrentLinkedQueue<>();
    /** ワークスペースごとの監視とリビジョン（自己書き込みの帰属はワークスペース内で完結する） */
    private final Map<String, Runtime> runtimes = new ConcurrentHashMap<>();
    private Javalin app;

    public WebServer(Path root, String token) {
        this.root = root;
        this.token = token;
    }

    /** ワークスペース1つ分のサーバー側状態。 */
    private static final class Runtime {
        final Revisions revisions = new Revisions();
        DataWatcher watcher;
    }

    /** basePort から空きポートを探して起動し、実際のポートを返す（§8.1）。 */
    public int start(int basePort) {
        for (int port = basePort; port < basePort + 20; port++) {
            try {
                app = create();
                app.start("127.0.0.1", port);
                // 起動時点のワークスペースをすべて監視する（作成・削除・改名で貼り替える）
                for (String id : WorkspaceStore.scan(root)) {
                    startWatching(id);
                }
                return port;
            } catch (RuntimeException e) {
                if (!isBindError(e)) throw e;
            }
        }
        throw new IllegalStateException("No available port found: " + basePort + "-" + (basePort + 19));
    }

    public void stop() {
        for (Runtime rt : runtimes.values()) {
            if (rt.watcher != null) rt.watcher.close();
        }
        runtimes.clear();
        if (app != null) app.stop();
    }

    private Javalin create() {
        Javalin javalin = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            cfg.jetty.defaultHost = "127.0.0.1";
        });

        // appVersion はビューアの information がサーバー版として表示する（A-02）。
        // index.html と jar は別々に差し替えられるため、ビューア側の版と食い違うことがある
        javalin.get("/__erd/health", ctx -> ctx.json(Map.of(
                "ok", true,
                "schemaVersion", SchemaVersions.CURRENT,
                "appVersion", AppVersion.current())));

        // ワークスペース管理（どのワークスペースにも属さない）
        javalin.get("/__erd/workspaces", this::listWorkspaces);
        javalin.post("/__erd/workspaces", this::createWorkspace);
        javalin.patch("/__erd/workspaces/{ws}", this::patchWorkspace);
        javalin.delete("/__erd/workspaces/{ws}", this::deleteWorkspace);

        // JDBC ドライバ（全ワークスペース共通。設定は erd/config.js、jar は erd/drivers/）
        javalin.get("/__erd/drivers", this::getDrivers);
        javalin.put("/__erd/drivers/config", this::putDriverConfig);
        javalin.post("/__erd/drivers/download", this::postDriverDownload);

        // 座標計算のみ（書き込みをしないためワークスペースに依存しない）
        javalin.post("/__erd/layout/auto", this::layoutAuto);

        // 閲覧用 ZIP（A-11）。複数ワークスペースを跨ぐため /w/{ws} には属さない
        javalin.post("/__erd/export/viewer", this::exportViewer);

        javalin.get("/__erd/w/{ws}/project", this::project);
        javalin.post("/__erd/w/{ws}/bootstrap", this::bootstrap);
        javalin.post("/__erd/w/{ws}/reset", this::resetData);

        // ページ管理（I-01〜I-03 / I-06）とレイアウト
        javalin.get("/__erd/w/{ws}/diagrams/{id}", this::getDiagram);
        javalin.post("/__erd/w/{ws}/diagrams", this::createDiagram);
        javalin.delete("/__erd/w/{ws}/diagrams/{id}", this::deleteDiagram);
        javalin.patch("/__erd/w/{ws}/diagrams/{id}", this::patchDiagram);

        javalin.get("/__erd/w/{ws}/tables/{id}", this::getTable);
        javalin.put("/__erd/w/{ws}/tables/{id}", this::putTable);
        javalin.get("/__erd/w/{ws}/dictionary", this::getDictionary);
        javalin.put("/__erd/w/{ws}/dictionary", this::putDictionary);
        javalin.get("/__erd/w/{ws}/config", this::getConfig);
        javalin.put("/__erd/w/{ws}/config", this::putConfig);

        // 逆生成（K-01〜K-14）
        javalin.get("/__erd/w/{ws}/connection", this::getConnection);
        javalin.put("/__erd/w/{ws}/connection", this::putConnection);
        javalin.post("/__erd/w/{ws}/connection/test", this::testConnection);
        javalin.post("/__erd/w/{ws}/introspect", this::postIntrospect);
        javalin.get("/__erd/w/{ws}/introspect/{sessionId}", this::getIntrospect);
        javalin.post("/__erd/w/{ws}/introspect/{sessionId}/plan", this::postIntrospectPlan);
        javalin.post("/__erd/w/{ws}/introspect/apply", this::postIntrospectApply);

        javalin.sse("/__erd/events", this::sse);

        javalin.get("/", this::serveIndex);
        javalin.get("/index.html", this::serveIndex);
        javalin.get("/" + WorkspaceStore.REGISTRY, this::serveRegistry);
        javalin.get("/" + Workspace.PREFIX + "{ws}/data/<path>", this::serveData);
        return javalin;
    }

    // ------------------------------------------------------------ workspaces

    /** プルダウンの中身（§2）。存在の正はフォルダ走査で、表示名は workspaces.js から。 */
    private void listWorkspaces(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        ctx.json(Map.of("workspaces", workspaces.list(root)));
    }

    /** 空のワークスペースを作る。中身の初期化はブートストラップ画面（§3.6）で行う。 */
    private void createWorkspace(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = ctx.body().isEmpty() ? mapper.createObjectNode() : mapper.readTree(ctx.body());
        String id = body.path("id").asText("").trim();
        if (id.isEmpty()) id = Workspace.DEFAULT_ID;
        String name = body.path("name").asText("").trim();
        if (!Workspace.isValidId(id)) {
            ctx.status(400).json(Map.of("code", "VALIDATION", "field", "id",
                    "message", "id must match [A-Za-z0-9][A-Za-z0-9_-]{0,31}"));
            return;
        }
        if (name.isEmpty()) {
            ctx.status(400).json(Map.of("code", "VALIDATION", "field", "name",
                    "message", "name is required"));
            return;
        }
        if (WorkspaceStore.conflicts(root, id)) {
            ctx.status(409).json(Map.of("code", "DUPLICATE_ID", "id", id));
            return;
        }
        Workspace created = workspaces.create(root, id, name);
        startWatching(created.id());
        System.out.println("Created workspace: " + WorkspaceStore.dir(root, created.id()));
        ctx.json(created);
    }

    /**
     * ID・表示名の変更。ID を変えるとフォルダ名も変わるため、Git 上は「削除＋追加」の差分になる
     * （警告は画面側で出す）。監視は貼り替える。
     */
    private void patchWorkspace(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        String oldId = ctx.pathParam("ws");
        Workspace current = workspaces.find(root, oldId);
        if (current == null) {
            ctx.status(404).json(Map.of("error", "workspace not found"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        String newId = body.hasNonNull("id") ? body.get("id").asText("").trim() : oldId;
        String newName = body.hasNonNull("name") ? body.get("name").asText("").trim() : current.name();
        if (!Workspace.isValidId(newId)) {
            ctx.status(400).json(Map.of("code", "VALIDATION", "field", "id",
                    "message", "id must match [A-Za-z0-9][A-Za-z0-9_-]{0,31}"));
            return;
        }
        if (newName.isEmpty()) {
            ctx.status(400).json(Map.of("code", "VALIDATION", "field", "name",
                    "message", "name is required"));
            return;
        }
        if (!newId.equals(oldId) && WorkspaceStore.conflicts(root, newId)) {
            ctx.status(409).json(Map.of("code", "DUPLICATE_ID", "id", newId));
            return;
        }
        if (!newId.equals(oldId)) stopWatching(oldId);
        Workspace renamed = workspaces.rename(root, oldId, newId, newName);
        if (!newId.equals(oldId)) startWatching(newId);
        ctx.json(renamed);
    }

    /** ワークスペースを丸ごと削除する（データリセットとは別物。§11）。 */
    private void deleteWorkspace(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        String id = ctx.pathParam("ws");
        if (!WorkspaceStore.exists(root, id)) {
            ctx.status(404).json(Map.of("error", "workspace not found"));
            return;
        }
        stopWatching(id);
        workspaces.delete(root, id);
        System.out.println("Deleted workspace: " + WorkspaceStore.dir(root, id));
        ctx.json(Map.of("ok", true, "workspaces", workspaces.list(root)));
    }

    // ------------------------------------------------------- workspace 解決

    /**
     * 書き込み・読み出しの共通ガード。トークンとワークスペースの存在を確かめ、
     * data ディレクトリを返す（不正なら応答を書いて null）。
     */
    private Path dataDirOrFail(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return null;
        }
        String id = ctx.pathParam("ws");
        if (!WorkspaceStore.exists(root, id)) {
            ctx.status(404).json(Map.of("error", "workspace not found"));
            return null;
        }
        return WorkspaceStore.dataDir(root, id);
    }

    private Revisions revisions(Context ctx) {
        return runtime(ctx.pathParam("ws")).revisions;
    }

    private Runtime runtime(String wsId) {
        return runtimes.computeIfAbsent(wsId, id -> new Runtime());
    }

    private void startWatching(String wsId) {
        Runtime rt = runtime(wsId);
        if (rt.watcher != null) return;
        rt.watcher = new DataWatcher(WorkspaceStore.dataDir(root, wsId), rt.revisions,
                (revision, files) -> broadcast(wsId, revision, files));
        rt.watcher.start();
    }

    private void stopWatching(String wsId) {
        Runtime rt = runtimes.remove(wsId);
        if (rt != null && rt.watcher != null) rt.watcher.close();
    }

    // --------------------------------------------------------------- project

    /** リビジョン・各ファイルの baseHash・schemaVersion・ブートストラップの要否（§8.2）。 */
    private void project(Context ctx) throws Exception {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        ObjectNode res = mapper.createObjectNode();
        res.put("schemaVersion", SchemaVersions.CURRENT);
        res.put("needsBootstrap", needsBootstrap(dataDir));
        ObjectNode files = res.putObject("files");
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
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        String hash = diagrams.baseHash(dataDir, ctx.pathParam("id"));
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
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        JsonNode body = ctx.body().isEmpty() ? mapper.createObjectNode() : mapper.readTree(ctx.body());
        DiagramService.Outcome outcome = op.apply(dataDir, body);
        if (outcome instanceof DiagramService.NotFound) {
            ctx.status(404).json(Map.of("error", "not found"));
        } else if (outcome instanceof DiagramService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof DiagramService.Duplicate dup) {
            ctx.status(409).json(Map.of("code", "DUPLICATE_ID", "id", dup.id()));
        } else if (outcome instanceof DiagramService.Invalid invalid) {
            ctx.status(400).json(Map.of("code", "VALIDATION", "message", invalid.message()));
        } else if (outcome instanceof DiagramService.Ok ok) {
            Revisions revisions = revisions(ctx);
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
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        String hash = tables.baseHash(dataDir, ctx.pathParam("id"));
        if (hash == null) {
            ctx.status(404).json(Map.of("error", "not found"));
            return;
        }
        ctx.json(Map.of("baseHash", hash));
    }

    /** テーブル1件の全文置換保存（O-08 / J-05 / §4.2）。baseHash が必須。 */
    private void putTable(Context ctx) throws Exception {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        JsonNode body = mapper.readTree(ctx.body());
        TableService.Outcome outcome = tables.put(dataDir, ctx.pathParam("id"), body);
        if (outcome instanceof TableService.NotFound) {
            ctx.status(404).json(Map.of("error", "not found"));
        } else if (outcome instanceof TableService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof TableService.Invalid invalid) {
            ctx.status(422).json(Map.of(
                    "code", "VALIDATION",
                    "errors", invalid.errors().stream().map(Issue::toMap).toList(),
                    "warnings", invalid.warnings().stream().map(Issue::toMap).toList()));
        } else if (outcome instanceof TableService.Ok ok) {
            Revisions revisions = revisions(ctx);
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ctx.json(Map.of(
                    "revision", revision,
                    "newHash", ok.newHash(),
                    "warnings", ok.warnings().stream().map(Issue::toMap).toList()));
        }
    }

    private void getDictionary(Context ctx) {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        ctx.json(Map.of("baseHash", dictionary.baseHash(dataDir)));
    }

    /** 辞書の一括更新（P-03 §2.4）。全体を1回の PUT で置換する。 */
    private void putDictionary(Context ctx) throws Exception {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        JsonNode body = mapper.readTree(ctx.body());
        DictionaryService.Outcome outcome = dictionary.put(dataDir, body);
        if (outcome instanceof DictionaryService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof DictionaryService.BadRequest bad) {
            ctx.status(400).json(Map.of("error", bad.message()));
        } else if (outcome instanceof DictionaryService.Invalid invalid) {
            ctx.status(422).json(Map.of(
                    "code", "VALIDATION",
                    "errors", invalid.errors().stream().map(Issue::toMap).toList()));
        } else if (outcome instanceof DictionaryService.Ok ok) {
            Revisions revisions = revisions(ctx);
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ctx.json(Map.of("revision", revision, "newHash", ok.newHash()));
        }
    }

    // ---------------------------------------------------- config（無視リスト / K-15）

    private void getConfig(Context ctx) {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        var cfg = config.read(dataDir);
        ObjectNode res = mapper.createObjectNode();
        res.put("baseHash", config.baseHash(dataDir));
        var arr = res.putArray("ignoreTables");
        cfg.ignoreTables().forEach(arr::add);
        ctx.json(res);
    }

    /** 無視リストの更新（§9.4）。config.js を書き換えるのみで、スキーマには一切触れない。 */
    private void putConfig(Context ctx) throws Exception {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        JsonNode body = mapper.readTree(ctx.body());
        ConfigService.Outcome outcome = config.put(dataDir, body);
        if (outcome instanceof ConfigService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof ConfigService.Invalid invalid) {
            ctx.status(400).json(Map.of("error", invalid.message()));
        } else if (outcome instanceof ConfigService.Ok ok) {
            Revisions revisions = revisions(ctx);
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ctx.json(Map.of("revision", revision, "newHash", ok.newHash()));
        }
    }

    // --------------------------------------------------------- 逆生成（K-01〜K-14）

    /**
     * K-01 / §7.2: ロード済みドライバ・既定カタログ・ドライバ設定・未取得の一覧。
     *
     * <p>ドライバ設定は<b>全ワークスペース共通</b>（{@code erd/config.js}）。接続先 DB が
     * ワークスペースごとに違っても、必要なドライバはチームで揃えたい設定だからである。
     */
    private void getDrivers(Context ctx) {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        DriverConfig cfg = config.read(root).drivers();
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
        res.put("baseHash", config.baseHash(root));
        ctx.json(res);
    }

    /**
     * A-11 / §3.2: 閲覧用 ZIP をレスポンスとして流す（サーバー側にファイルを残さない）。
     *
     * <p>ボディは {@code {prefix, workspaces:[...]}}。中身の線引きもファイル名の規則も
     * {@link ViewerExport} に一本化してあり、CLI（{@code erd export}）と完全に同じものが出る。
     */
    private void exportViewer(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = ctx.body().isEmpty() ? mapper.createObjectNode() : mapper.readTree(ctx.body());
        String prefix = body.path("prefix").isTextual()
                ? body.path("prefix").asText() : ViewerExport.DEFAULT_PREFIX;
        List<String> workspaces = new ArrayList<>();
        for (JsonNode id : body.path("workspaces")) {
            if (id.isTextual()) workspaces.add(id.asText());
        }

        String error = ViewerExport.prefixError(prefix);
        if (error != null) {
            ctx.status(400).json(Map.of("code", "INVALID_PREFIX", "message", error));
            return;
        }
        List<String> resolved;
        try {
            resolved = ViewerExport.resolveWorkspaces(root, workspaces);
        } catch (IllegalArgumentException e) {
            ctx.status(400).json(Map.of("code", "UNKNOWN_WORKSPACE", "message", e.getMessage()));
            return;
        }
        if (resolved.isEmpty()) {
            ctx.status(400).json(Map.of("code", "NO_WORKSPACE",
                    "message", "There is no workspace to export."));
            return;
        }

        String fileName = ViewerExport.fileName(prefix);
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try {
            ViewerExport.writeTo(root, resolved, buffer);
        } catch (IOException e) {
            ctx.status(500).json(Map.of("code", "EXPORT_FAILED", "message", String.valueOf(e.getMessage())));
            return;
        }
        ctx.contentType("application/zip");
        ctx.header("Content-Disposition", contentDisposition(fileName));
        ctx.result(buffer.toByteArray());
    }

    /**
     * 日本語などを含むファイル名でも壊れないようにする（RFC 5987）。ASCII だけに落とした
     * 名前を filename に、実際の名前を filename* に入れる（古いブラウザは前者を使う）。
     */
    private static String contentDisposition(String fileName) {
        StringBuilder ascii = new StringBuilder();
        for (char c : fileName.toCharArray()) {
            ascii.append(c < 0x80 && c != '"' && c != '\\' ? c : '_');
        }
        String encoded = URLEncoder.encode(fileName, StandardCharsets.UTF_8).replace("+", "%20");
        return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encoded;
    }

    /** 共通のドライバ設定（{@code erd/config.js}）の更新。 */
    private void putDriverConfig(Context ctx) throws Exception {
        if (!authorized(ctx)) {
            ctx.status(403).json(Map.of("error", "forbidden"));
            return;
        }
        JsonNode body = mapper.readTree(ctx.body());
        ConfigService.Outcome outcome = config.put(root, body);
        if (outcome instanceof ConfigService.Stale stale) {
            ctx.status(409).json(Map.of("code", "STALE", "currentHash", stale.currentHash()));
        } else if (outcome instanceof ConfigService.Invalid invalid) {
            ctx.status(400).json(Map.of("error", invalid.message()));
        } else if (outcome instanceof ConfigService.Ok ok) {
            // erd/config.js は data/ の外にあり、ファイル監視・SSE の対象ではない
            ctx.json(Map.of("ok", true, "newHash", ok.newHash()));
        }
    }

    /**
     * §7.2: ドライバ座標を Maven からダウンロードして {@code drivers/} に置き、登録する。
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
            repo = config.read(root).drivers().mavenRepository();
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

    /** {@code drivers/}（Git 管理外。JDBC ドライバの jar 置き場。全ワークスペース共通。§7.2）。 */
    private Path driversDir() {
        return root.resolve("drivers");
    }

    /** K-05: 保存された接続設定（パスワードは明示的に保存した場合のみ含む）。 */
    private void getConnection(Context ctx) {
        if (dataDirOrFail(ctx) == null) return;
        ctx.json(connections.forClient(privateDir(ctx)));
    }

    private void putConnection(Context ctx) throws Exception {
        if (dataDirOrFail(ctx) == null) return;
        JsonNode body = mapper.readTree(ctx.body());
        if (body.path("clear").asBoolean(false)) {
            connections.delete(privateDir(ctx));
        } else {
            connections.save(privateDir(ctx), body);
        }
        ctx.json(Map.of("ok", true));
    }

    /** K-04: 接続テスト（製品名・バージョン・ネームスペース一覧）。 */
    private void testConnection(Context ctx) throws Exception {
        if (dataDirOrFail(ctx) == null) return;
        try {
            ctx.json(introspect.test(mapper.readTree(ctx.body())));
        } catch (java.sql.SQLException e) {
            ctx.status(400).json(Map.of("code", "CONNECT_FAILED", "message", String.valueOf(e.getMessage())));
        }
    }

    /** K-07 → K-08: 逆生成を実行し、差分プレビューを返す（1バイトも書き込まない。INV-4）。 */
    private void postIntrospect(Context ctx) throws Exception {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        try {
            respond(ctx, introspect.preview(ctx.pathParam("ws"), privateDir(ctx), dataDir,
                    mapper.readTree(ctx.body())));
        } catch (java.sql.SQLException e) {
            ctx.status(400).json(Map.of("code", "CONNECT_FAILED", "message", String.valueOf(e.getMessage())));
        }
    }

    /** プレビューの再取得（ブラウザのリロード対策）。失効時は 410。 */
    private void getIntrospect(Context ctx) {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        respond(ctx, introspect.reload(ctx.pathParam("ws"), privateDir(ctx), dataDir,
                ctx.pathParam("sessionId"), List.of()));
    }

    /**
     * リネーム決定を反映したプランの再計算（DB へは再接続しない）。
     * 差分ロジックはサーバーの単一実装に集約し、UI 側に持たせない。
     */
    private void postIntrospectPlan(Context ctx) throws Exception {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        JsonNode body = mapper.readTree(ctx.body());
        respond(ctx, introspect.reload(ctx.pathParam("ws"), privateDir(ctx), dataDir,
                ctx.pathParam("sessionId"), introspect.decisions(body.path("renameDecisions"))));
    }

    /**
     * K-11: 差分の適用。置換中は SSE の配信を抑止し、完了後に単一のリビジョンとして
     * まとめて通知する（§8.6。中間状態をビューアに読ませない）。
     */
    private void postIntrospectApply(Context ctx) throws Exception {
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        String wsId = ctx.pathParam("ws");
        JsonNode body = mapper.readTree(ctx.body());
        IntrospectService.Outcome outcome;
        DataWatcher watcher = runtime(wsId).watcher;
        if (watcher != null) watcher.suppress(true);
        try {
            outcome = introspect.apply(wsId, privateDir(ctx), dataDir, body);
        } finally {
            if (watcher != null) watcher.suppress(false);
        }
        if (outcome instanceof IntrospectService.Ok ok && !ok.writtenFiles().isEmpty()) {
            Revisions revisions = revisions(ctx);
            String revision = revisions.next();
            ok.writtenFiles().forEach((rel, hash) -> revisions.recordWrite(rel, hash, revision));
            ObjectNode res = mapper.valueToTree(ok.body());
            res.put("revision", revision);
            broadcast(wsId, revision, ok.writtenFiles().keySet());
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

    /** {@code erd/.local/workspace-<id>/}（Git 管理外。接続設定・バックアップ）。 */
    private Path privateDir(Context ctx) {
        return WorkspaceStore.privateDir(root, ctx.pathParam("ws"));
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

    /**
     * ファイル監視からの変更通知を全クライアントへ配る（H-09）。
     * どのワークスペースの変更かを載せる（別のワークスペースを開いているタブが反応しないように）。
     */
    private void broadcast(String wsId, String revision, Set<String> files) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("workspaceId", wsId);
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
        Path dataDir = dataDirOrFail(ctx);
        if (dataDir == null) return;
        String mode = ctx.body().isEmpty() ? "" : mapper.readTree(ctx.body()).path("mode").asText("");
        if (!"sample".equals(mode)) {
            ctx.status(400).json(Map.of("error", "unsupported mode: " + mode));
            return;
        }
        if (!needsBootstrap(dataDir)) {
            ctx.status(409).json(Map.of("error", "already-initialized"));
            return;
        }
        int tables = quietly(ctx.pathParam("ws"), () -> SampleData.writeTo(dataDir));
        System.out.println("Wrote sample data (" + tables + " tables): " + dataDir);
        ctx.json(Map.of("ok", true, "tables", tables));
    }

    /**
     * 監視を抑止したまま書き込み、拾い終わってから解く。
     *
     * <p>ブートストラップとデータリセットは、完了後にクライアントがページごと読み込み直す。
     * SSE で伝える相手がいないのに監視だけは変更を拾うため、抑止しないと
     * <b>リロード直後のタブに「外部の変更を反映しました」が出てしまう</b>（自分の操作なのに
     * 他人の変更に見える）。逆生成の適用（§8.6）と違い、まとめ直した通知も送らない。
     */
    private <T> T quietly(String wsId, java.util.concurrent.Callable<T> body) throws Exception {
        DataWatcher watcher = runtime(wsId).watcher;
        if (watcher == null) return body.call();
        watcher.suppress(true);
        try {
            return body.call();
        } finally {
            watcher.settleThenResume();
        }
    }

    /**
     * データリセット（設定メニュー）。<b>そのワークスペースの</b>スキーマ情報をすべて削除する。
     * schema/**・diagrams/**・index.js・dictionary.js・manifest.js を消し、config.js は残す
     * （無視リストなど human-owned な設定を保持する）。ワークスペース自体は残るため、
     * 削除後はブートストラップ画面（空プロジェクト）に着地する。
     */
    private void resetData(Context ctx) throws Exception {
        Path data = dataDirOrFail(ctx);
        if (data == null) return;
        quietly(ctx.pathParam("ws"), () -> {
            deleteRecursively(data.resolve("schema"));
            deleteRecursively(data.resolve("diagrams"));
            Files.deleteIfExists(data.resolve("index.js"));
            Files.deleteIfExists(data.resolve("dictionary.js"));
            Files.deleteIfExists(data.resolve("manifest.js"));
            return null;
        });
        System.out.println("Reset schema data (kept config.js): " + data);
        ctx.json(Map.of("ok", true));
    }

    /** ディレクトリを中身ごと削除する（存在しなければ何もしない）。 */
    private static void deleteRecursively(Path dir) throws java.io.IOException {
        WorkspaceStore.deleteTree(dir);
    }

    /** manifest.js が無い、またはテーブル0件のときのみブートストラップ可能（§3.6）。 */
    private boolean needsBootstrap(Path dataDir) {
        Path manifest = dataDir.resolve("manifest.js");
        if (!Files.exists(manifest)) return true;
        try {
            return store.readManifestOnly(dataDir).tables().isEmpty();
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

    /**
     * ワークスペースの索引（§2）。file:// と同じ相対パスで読めるよう、ここでも配信する。
     * 走査結果とずれていれば書き直してから返す（外から workspace-* を足された場合に追随する）。
     */
    private void serveRegistry(Context ctx) throws Exception {
        workspaces.list(root);
        Path file = root.resolve(WorkspaceStore.REGISTRY);
        ctx.header("Cache-Control", "no-cache");
        ctx.contentType("text/javascript; charset=utf-8");
        if (Files.isRegularFile(file)) {
            ctx.result(Files.readAllBytes(file));
        } else {
            ctx.result("ERD.workspaces({\n  workspaces: [\n  ],\n});\n");
        }
    }

    private void serveData(Context ctx) throws Exception {
        String wsId = ctx.pathParam("ws");
        if (!WorkspaceStore.exists(root, wsId)) {
            ctx.status(404).contentType("text/plain; charset=utf-8").result("not found");
            return;
        }
        Path base = WorkspaceStore.dataDir(root, wsId).normalize();
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
