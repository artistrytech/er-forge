package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.http.Context;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

/**
 * MCP のエンドポイント（§8.8 / Q-02）。{@code POST /__erd/mcp}。
 *
 * <p><b>2 つの世代を同時に喋る（dual-era）。</b> 仕様は改訂 {@code 2026-07-28} で
 * 大きく変わり、{@code initialize} のハンドシェイクが廃止されて<b>リクエストごとに
 * メタ情報を載せるステートレス方式</b>になった。仕様の互換性マトリクスによれば
 * 「旧クライアント × 新のみのサーバー」は<b>失敗する</b>ため、どちらか一方だけを実装すると
 * 手元のクライアントか将来のクライアントのどちらかで動かない。仕様自身が
 * 「dual-era サーバーは同一エンドポイントで両方を提供してよい」と認めている。
 *
 * <p>世代の判定は仕様どおり<b>リクエストの形</b>で行う:
 * <ul>
 *   <li>{@code params._meta["io.modelcontextprotocol/protocolVersion"]} がある → modern</li>
 *   <li>{@code initialize} が来た → legacy</li>
 * </ul>
 *
 * <p>実装しない部分（いずれも仕様上許容される）: SSE 応答ストリーム（通知を送らないため
 * 常に {@code application/json} で返す）、セッション（{@code Mcp-Session-Id} を発行しない）、
 * {@code GET} / {@code DELETE}（405 を返す）。
 */
final class McpEndpoint {

    /** 実装している最新リビジョン。ここを 1 か所に置き、テストで固定する。 */
    static final String MODERN_VERSION = "2026-07-28";

    /** 応答する順に並べた対応版（先頭が既定）。legacy 側は initialize でネゴシエートする。 */
    static final List<String> SUPPORTED_VERSIONS =
            List.of(MODERN_VERSION, "2025-11-25", "2025-06-18", "2025-03-26");

    private static final String META = "_meta";
    private static final String META_VERSION = "io.modelcontextprotocol/protocolVersion";
    private static final String META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

    // JSON-RPC / MCP のエラーコード
    private static final int PARSE_ERROR = -32700;
    private static final int INVALID_REQUEST = -32600;
    private static final int METHOD_NOT_FOUND = -32601;
    private static final int INVALID_PARAMS = -32602;
    private static final int INTERNAL_ERROR = -32603;
    private static final int HEADER_MISMATCH = -32020;
    private static final int UNSUPPORTED_VERSION = -32022;

    private static final String SENTINEL_PREFIX = "=?base64?";
    private static final String SENTINEL_SUFFIX = "?=";

    private final ObjectMapper mapper = new ObjectMapper();
    private final McpSettings settings;
    private final McpTools tools = new McpTools();
    private final Path root;

    McpEndpoint(Path root, McpSettings settings) {
        this.root = root;
        this.settings = settings;
    }

    // ------------------------------------------------------------- HTTP 入口

    /** {@code GET} / {@code DELETE}: 旧リビジョンの SSE ストリームとセッション終了。実装しない。 */
    void methodNotAllowed(Context ctx) {
        if (!settings.enabled(root)) {
            notFound(ctx);
            return;
        }
        ctx.status(405).contentType("text/plain; charset=utf-8")
                .result("This MCP endpoint accepts POST only.");
    }

    void handle(Context ctx) {
        // 無効時は「エンドポイントが存在しない」ように振る舞う（INV-7）
        if (!settings.enabled(root)) {
            notFound(ctx);
            return;
        }
        if (!authorized(ctx)) {
            // Origin が不正な場合の 403 は仕様が明示的に要求している
            ctx.status(403).contentType("application/json; charset=utf-8")
                    .result(errorBody(null, INVALID_REQUEST, "forbidden"));
            return;
        }

        JsonNode request;
        try {
            request = mapper.readTree(ctx.body());
        } catch (Exception e) {
            respond(ctx, 400, errorBody(null, PARSE_ERROR, "Parse error"));
            return;
        }
        if (request == null || !request.isObject()) {
            respond(ctx, 400, errorBody(null, INVALID_REQUEST, "Invalid Request"));
            return;
        }

        String method = request.path("method").asText("");
        JsonNode id = request.get("id");
        JsonNode params = request.path("params");

        // 通知（id なし）は 202 を返して終わる。本リビジョンの core にクライアント発の通知は
        // 無いが、legacy の notifications/initialized がここに来る
        if (id == null || id.isNull()) {
            ctx.status(202).result("");
            return;
        }

        boolean modern = params.path(META).hasNonNull(META_VERSION);
        // 「繋がっているか」「どちらの世代で来ているか」を残す。接続の切り分けで最初に見る情報で、
        // ツールを1回も呼ばずに終わる接続もあるため、ツール呼び出しに限らず記録する。
        // tools/call はメソッド名よりツール名のほうが役に立つので、callTool 側で記録する
        if (!method.equals("tools/call")) {
            settings.touch(root, method, modern ? "modern" : "legacy", false);
        }
        try {
            if (modern) {
                handleModern(ctx, id, method, params);
            } else {
                handleLegacy(ctx, id, method, params);
            }
        } catch (McpTools.ToolException e) {
            // ここに来るのは load 失敗など。ツール実行のエラーは isError で返している
            respond(ctx, 200, resultBody(id, toolError(e.getMessage(), modern), modern));
        } catch (RuntimeException e) {
            respond(ctx, 200, errorBody(id, INTERNAL_ERROR, String.valueOf(e.getMessage())));
        }
    }

    // ------------------------------------------------------------ modern 世代

    private void handleModern(Context ctx, JsonNode id, String method, JsonNode params) {
        String bodyVersion = params.path(META).path(META_VERSION).asText("");
        String headerVersion = ctx.header("MCP-Protocol-Version");

        // ヘッダと本文の食い違いは拒否する（経路によって解釈が変わる余地を作らない）
        if (headerVersion == null || !headerVersion.equals(bodyVersion)) {
            respond(ctx, 400, errorBody(id, HEADER_MISMATCH,
                    "MCP-Protocol-Version header (" + headerVersion + ") does not match "
                            + "the protocol version in the request body (" + bodyVersion + ")"));
            return;
        }
        if (!MODERN_VERSION.equals(bodyVersion)) {
            ObjectNode data = mapper.createObjectNode();
            ArrayNode supported = data.putArray("supported");
            SUPPORTED_VERSIONS.forEach(supported::add);
            data.put("requested", bodyVersion);
            respond(ctx, 400, errorBody(id, UNSUPPORTED_VERSION, "Unsupported protocol version", data));
            return;
        }
        String methodHeader = ctx.header("Mcp-Method");
        if (methodHeader == null || !methodHeader.equals(method)) {
            respond(ctx, 400, errorBody(id, HEADER_MISMATCH,
                    "Mcp-Method header (" + methodHeader + ") does not match the body method (" + method + ")"));
            return;
        }

        switch (method) {
            case "server/discover" -> respond(ctx, 200, resultBody(id, discoverResult(), true));
            case "tools/list" -> respond(ctx, 200, resultBody(id, toolsList(true), true));
            case "tools/call" -> {
                String name = params.path("name").asText("");
                String nameHeader = decodeSentinel(ctx.header("Mcp-Name"));
                if (nameHeader == null || !nameHeader.equals(name)) {
                    respond(ctx, 400, errorBody(id, HEADER_MISMATCH,
                            "Mcp-Name header (" + nameHeader + ") does not match "
                                    + "the tool name in the request body (" + name + ")"));
                    return;
                }
                callTool(ctx, id, params, true);
            }
            case "ping" -> respond(ctx, 200, resultBody(id, mapper.createObjectNode(), true));
            // 未知のメソッドは 404 + -32601（legacy の HTTP+SSE サーバーの 404 と区別できるよう本文を付ける）
            default -> respond(ctx, 404, errorBody(id, METHOD_NOT_FOUND, "Method not found: " + method));
        }
    }

    private ObjectNode discoverResult() {
        ObjectNode result = mapper.createObjectNode();
        ArrayNode versions = result.putArray("supportedVersions");
        versions.add(MODERN_VERSION);
        result.putObject("capabilities").putObject("tools");
        result.putObject(META).set(META_SERVER_INFO, serverInfo());
        result.put("instructions", instructions());
        return cacheHints(result);
    }

    /**
     * キャッシュのヒント。modern では {@code resultType: "complete"} を返す
     * {@code server/discover} と {@code tools/list} に<b>必須</b>である（付けないとクライアントの
     * スキーマ検証で落ちる）。{@code tools/call} は対象外。
     *
     * <p><b>キャッシュさせない（{@code ttlMs: 0}）。</b> ツール一覧は画面の「書き込みを許可」で
     * 変わるが、こちらは {@code listChanged} も購読も実装していないため、クライアントに
     * 無効化の合図を送る手段が無い。キャッシュを許すと、トグルを切り替えても
     * 反映されない時間ができる。相手は同じマシンの中に居るので、毎回取り直しても実質ただである。
     *
     * <p>{@code cacheScope} は {@code private}。内容は呼び出し元によらず同じだが、
     * {@code public} は「別の資格情報のキャッシュと共有してよい」という意味になる。
     * スキーマを外へ出さないことがこの機能の前提（INV-2）なので、共有を許す側には倒さない。
     */
    private ObjectNode cacheHints(ObjectNode result) {
        result.put("ttlMs", 0);
        result.put("cacheScope", "private");
        return result;
    }

    // ------------------------------------------------------------ legacy 世代

    private void handleLegacy(Context ctx, JsonNode id, String method, JsonNode params) {
        switch (method) {
            case "initialize" -> {
                String requested = params.path("protocolVersion").asText("");
                // クライアントの提示版をサポートしていればそのまま返し、していなければ自分の版を返す
                String agreed = SUPPORTED_VERSIONS.contains(requested)
                        ? requested : SUPPORTED_VERSIONS.get(1);
                ObjectNode result = mapper.createObjectNode();
                result.put("protocolVersion", agreed);
                result.putObject("capabilities").putObject("tools");
                result.set("serverInfo", serverInfo());
                result.put("instructions", instructions());
                respond(ctx, 200, resultBody(id, result, false));
            }
            case "tools/list" -> respond(ctx, 200, resultBody(id, toolsList(false), false));
            case "tools/call" -> callTool(ctx, id, params, false);
            case "ping" -> respond(ctx, 200, resultBody(id, mapper.createObjectNode(), false));
            default -> respond(ctx, 200, errorBody(id, METHOD_NOT_FOUND, "Method not found: " + method));
        }
    }

    // ------------------------------------------------------------ 共通の中身

    private ObjectNode toolsList(boolean modern) {
        ObjectNode result = mapper.createObjectNode();
        if (modern) result.put("resultType", "complete");
        result.set("tools", tools.definitions(settings.writeAllowed(root)));
        // legacy にはキャッシュヒントの概念が無いので付けない
        return modern ? cacheHints(result) : result;
    }

    private void callTool(Context ctx, JsonNode id, JsonNode params, boolean modern) {
        String name = params.path("name").asText("");
        if (name.isEmpty()) {
            respond(ctx, 200, errorBody(id, INVALID_PARAMS, "\"name\" is required"));
            return;
        }
        if (!tools.isKnown(name)) {
            // 「書き込み許可がオフのときは直接呼んでも拒否する」（INV-6）もここで効く:
            // 未公開のツールは isKnown が false になる
            respond(ctx, 200, errorBody(id, INVALID_PARAMS, "Unknown tool: " + name));
            return;
        }
        settings.touch(root, name, modern ? "modern" : "legacy", false);
        JsonNode arguments = params.path("arguments");
        try {
            String text = tools.call(root, name, arguments);
            respond(ctx, 200, resultBody(id, textResult(text, false, modern), modern));
        } catch (McpTools.ToolException e) {
            // 入力の誤りはモデルが自力で直せる。JSON-RPC error ではなく isError で返す
            respond(ctx, 200, resultBody(id, toolError(e.getMessage(), modern), modern));
        } catch (IllegalArgumentException e) {
            respond(ctx, 200, errorBody(id, INVALID_PARAMS, String.valueOf(e.getMessage())));
        } catch (RuntimeException e) {
            respond(ctx, 200, resultBody(id,
                    toolError("The tool failed: " + e.getMessage(), modern), modern));
        }
    }

    private ObjectNode toolError(String message, boolean modern) {
        return textResult(message, true, modern);
    }

    private ObjectNode textResult(String text, boolean isError, boolean modern) {
        ObjectNode result = mapper.createObjectNode();
        if (modern) result.put("resultType", "complete");
        ArrayNode content = result.putArray("content");
        content.addObject().put("type", "text").put("text", text);
        result.put("isError", isError);
        return result;
    }

    private ObjectNode serverInfo() {
        return mapper.createObjectNode().put("name", "erforge").put("version", AppVersion.current());
    }

    private String instructions() {
        return "ERForge manages ER diagrams and table definitions for a database. "
                + "Physical information (columns, types, keys, indexes) comes from the database and is "
                + "read-only here. Start with erd_list_tables to see what exists.";
    }

    // -------------------------------------------------------------- 認証・応答

    /**
     * MCP のガード（§8.5）。<b>セッショントークンは通用しない</b>（INV-3）。
     *
     * <p>{@code Origin} は既存ルートより厳しく、「無い（＝ブラウザ以外のクライアント）」か
     * 「自分自身のオリジンと完全一致」のみ許可する。{@code Host} 検証は全ルート共通の
     * {@code before} で先に済んでいる。
     */
    private boolean authorized(Context ctx) {
        String origin = ctx.header("Origin");
        if (origin != null && !origin.equals("http://" + ctx.header("Host"))) return false;
        String presented = bearer(ctx.header("Authorization"));
        return settings.tokenMatches(root, presented);
    }

    private static String bearer(String header) {
        if (header == null) return null;
        String prefix = "Bearer ";
        return header.regionMatches(true, 0, prefix, 0, prefix.length())
                ? header.substring(prefix.length()).trim() : null;
    }

    /** ヘッダ値の Base64 センチネル（{@code =?base64?…?=}）を戻す。 */
    private static String decodeSentinel(String value) {
        if (value == null) return null;
        if (!value.startsWith(SENTINEL_PREFIX) || !value.endsWith(SENTINEL_SUFFIX)) return value;
        String encoded = value.substring(SENTINEL_PREFIX.length(),
                value.length() - SENTINEL_SUFFIX.length());
        try {
            return new String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return value;
        }
    }

    private void notFound(Context ctx) {
        ctx.status(404).contentType("text/plain; charset=utf-8").result("not found");
    }

    private void respond(Context ctx, int status, String body) {
        ctx.status(status).contentType("application/json; charset=utf-8").result(body);
    }

    private String resultBody(JsonNode id, ObjectNode result, boolean modern) {
        if (modern && !result.has("resultType")) result.put("resultType", "complete");
        ObjectNode envelope = mapper.createObjectNode();
        envelope.put("jsonrpc", "2.0");
        envelope.set("id", id);
        envelope.set("result", result);
        return write(envelope);
    }

    private String errorBody(JsonNode id, int code, String message) {
        return errorBody(id, code, message, null);
    }

    private String errorBody(JsonNode id, int code, String message, ObjectNode data) {
        ObjectNode envelope = mapper.createObjectNode();
        envelope.put("jsonrpc", "2.0");
        if (id == null) envelope.putNull("id");
        else envelope.set("id", id);
        ObjectNode error = envelope.putObject("error");
        error.put("code", code);
        error.put("message", message);
        if (data != null) error.set("data", data);
        return write(envelope);
    }

    private String write(ObjectNode node) {
        try {
            return mapper.writeValueAsString(node);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
