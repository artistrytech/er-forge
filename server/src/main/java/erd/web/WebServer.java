package erd.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import io.javalin.Javalin;
import io.javalin.http.Context;

import java.net.BindException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;

/**
 * フェーズ2の最小 Web サーバー。
 *
 * <p>責務は「静的配信 + ブートストラップ」まで（編集系 API・SSE はフェーズ3）。
 * データの読み込み経路はモードにかかわらず data/**.js の &lt;script&gt; 注入1本であり（§4.3）、
 * サーバーは data/** を静的ファイルとして配信するだけでよい。
 */
public final class WebServer {

    private final Path root;      // erd/（index.html と data/ を含む）
    private final String token;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ProjectStore store = new ProjectStore();
    private Javalin app;

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
                return port;
            } catch (RuntimeException e) {
                if (!isBindError(e)) throw e;
            }
        }
        throw new IllegalStateException("空きポートが見つかりません: " + basePort + "〜" + (basePort + 19));
    }

    public void stop() {
        if (app != null) app.stop();
    }

    private Javalin create() {
        Javalin javalin = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            cfg.jetty.defaultHost = "127.0.0.1";
        });

        javalin.get("/__erd/health", ctx ->
                ctx.json(Map.of("ok", true, "schemaVersion", SchemaVersions.CURRENT)));

        javalin.post("/__erd/bootstrap", this::bootstrap);

        javalin.get("/", this::serveIndex);
        javalin.get("/index.html", this::serveIndex);
        javalin.get("/data/<path>", this::serveData);
        return javalin;
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
