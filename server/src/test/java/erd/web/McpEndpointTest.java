package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import erd.core.model.Column;
import erd.core.model.DiagramPage;
import erd.core.model.Dictionary;
import erd.core.model.LogicalType;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
import erd.core.model.ProjectConfig;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * MCP エンドポイント（§8.8 / Q-02）。
 *
 * <p>認証と公開範囲を最優先で固定する。ここは「うっかり通った」がそのまま事故になる場所である。
 */
class McpEndpointTest {

    private static final String SESSION_TOKEN = "session-token";

    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    @TempDir
    Path tmp;

    private Path root;
    private WebServer server;
    private String origin;
    private String mcpToken;

    @BeforeEach
    void setup() throws Exception {
        root = tmp.resolve("erd");
        Files.createDirectories(root);
        Path dataDir = root.resolve("workspace-default/data");

        Table users = table("users", "ユーザー");
        Table orders = table("orders", null);
        DiagramPage core = new DiagramPage("core", "コア", 1,
                Map.of("public.users", new NodeLayout(new Point(120, 80), 260, Map.of())),
                Map.of());
        Manifest manifest = new Manifest(SchemaVersions.CURRENT, "config.js", "dictionary.js",
                Map.of(), List.of(), Map.of());
        new ProjectStore().writeAll(dataDir, new ProjectModel(manifest, ProjectConfig.EMPTY,
                Dictionary.EMPTY, List.of(users, orders), List.of(core)));

        server = new WebServer(root, SESSION_TOKEN);
        int port = server.start(5394);
        origin = "http://127.0.0.1:" + port;
    }

    @AfterEach
    void tearDown() {
        if (server != null) server.stop();
    }

    private static Table table(String name, String displayName) {
        TableMeta meta = displayName == null ? TableMeta.EMPTY
                : new TableMeta(displayName, List.of(), null, null, Map.of(),
                        List.of(), List.of(), Map.of(), Map.of());
        return new Table("public." + name,
                new TableSchema(name, "public", null,
                        List.of(new Column("id", "int4", LogicalType.INT, false)),
                        List.of("id"), List.of(), List.of(), List.of(), Map.of()),
                meta, Map.of());
    }

    // -------------------------------------------------------------------- T-1

    @Test
    @DisplayName("無効なあいだはエンドポイントが存在しない（404）")
    void disabledLooksAbsent() throws Exception {
        HttpResponse<String> res = mcp(null, legacy("tools/list", null), Map.of());
        assertEquals(404, res.statusCode());
    }

    @Test
    @DisplayName("トークン無し・誤トークン・セッショントークンはすべて 403")
    void tokenRequired() throws Exception {
        enableMcp(false);
        assertEquals(403, mcp(null, legacy("tools/list", null), Map.of()).statusCode());
        assertEquals(403, mcp("wrong", legacy("tools/list", null), Map.of()).statusCode());
        assertEquals(403, mcp(SESSION_TOKEN, legacy("tools/list", null), Map.of()).statusCode(),
                "セッショントークンで MCP を叩けてはならない（INV-3）");
    }

    @Test
    @DisplayName("GET / DELETE は 405（旧リビジョンの SSE ストリームは実装しない）")
    void getAndDeleteNotAllowed() throws Exception {
        enableMcp(false);
        HttpRequest get = HttpRequest.newBuilder(URI.create(origin + "/__erd/mcp")).GET().build();
        assertEquals(405, http.send(get, HttpResponse.BodyHandlers.ofString()).statusCode());
    }

    // ---------------------------------------------------------------- legacy

    @Test
    @DisplayName("legacy: initialize は提示された版をそのまま返す")
    void legacyInitialize() throws Exception {
        enableMcp(false);
        JsonNode result = ok(mcp(mcpToken,
                legacy("initialize", mapper.createObjectNode().put("protocolVersion", "2025-11-25")),
                Map.of()));
        assertEquals("2025-11-25", result.path("protocolVersion").asText());
        assertEquals("erforge", result.path("serverInfo").path("name").asText());
        assertTrue(result.path("capabilities").has("tools"));
    }

    @Test
    @DisplayName("legacy: tools/call が実データを返す")
    void legacyToolsCall() throws Exception {
        enableMcp(false);
        JsonNode result = ok(mcp(mcpToken, call("erd_list_tables", mapper.createObjectNode()), Map.of()));
        assertFalse(result.path("isError").asBoolean(), "isError が立っている: " + result);
        String text = result.path("content").get(0).path("text").asText();
        assertTrue(text.contains("public.users"), text);
        assertTrue(text.contains("ユーザー"), "論理名が返っていない: " + text);
    }

    @Test
    @DisplayName("入力の誤りは JSON-RPC error ではなく isError で返す（モデルが自力で直せるように）")
    void inputErrorsAreToolErrors() throws Exception {
        enableMcp(false);
        JsonNode result = ok(mcp(mcpToken,
                call("erd_get_table", mapper.createObjectNode().put("tableId", "public.nope")),
                Map.of()));
        assertTrue(result.path("isError").asBoolean(), "isError が立っていない: " + result);
        String text = result.path("content").get(0).path("text").asText();
        assertTrue(text.contains("public.users"), "候補が示されていない: " + text);
    }

    // -------------------------------------------------------------------- T-6

    @Test
    @DisplayName("公開範囲: 読み取り8種のみ。逆生成・接続情報・削除系は存在しない")
    void toolSurfaceIsBounded() throws Exception {
        enableMcp(true);   // 書き込みを許可しても、まだ書き込みツールは無い
        JsonNode result = ok(mcp(mcpToken, legacy("tools/list", null), Map.of()));
        List<String> names = new ArrayList<>();
        result.path("tools").forEach(t -> names.add(t.path("name").asText()));

        assertEquals(List.of("erd_list_workspaces", "erd_list_tables", "erd_get_table",
                "erd_list_relations", "erd_search", "erd_list_diagrams", "erd_get_diagram",
                "erd_get_dictionary"), names);
        for (String forbidden : List.of("introspect", "connection", "driver", "delete",
                "reset", "export", "workspace_create", "rename")) {
            assertTrue(names.stream().noneMatch(n -> n.contains(forbidden)),
                    "出してはならないツールがある: " + forbidden + " / " + names);
        }
    }

    // ---------------------------------------------------------------- modern

    @Test
    @DisplayName("modern: server/discover が対応版を返す")
    void modernDiscover() throws Exception {
        enableMcp(false);
        JsonNode result = ok(mcp(mcpToken, modern("server/discover", null),
                Map.of("MCP-Protocol-Version", McpEndpoint.MODERN_VERSION,
                        "Mcp-Method", "server/discover")));
        assertEquals(McpEndpoint.MODERN_VERSION, result.path("supportedVersions").get(0).asText());
        assertTrue(result.path("capabilities").has("tools"));
    }

    @Test
    @DisplayName("modern: tools/call はヘッダと本文の一致を要求する")
    void modernHeaderValidation() throws Exception {
        enableMcp(false);
        var params = mapper.createObjectNode();
        params.put("name", "erd_list_workspaces");
        params.set("arguments", mapper.createObjectNode());

        // 正しいヘッダ
        HttpResponse<String> good = mcp(mcpToken, modern("tools/call", params),
                Map.of("MCP-Protocol-Version", McpEndpoint.MODERN_VERSION,
                        "Mcp-Method", "tools/call", "Mcp-Name", "erd_list_workspaces"));
        assertEquals(200, good.statusCode());
        assertEquals("complete", body(good).path("result").path("resultType").asText());

        // Mcp-Name が本文と食い違う
        HttpResponse<String> mismatch = mcp(mcpToken, modern("tools/call", params),
                Map.of("MCP-Protocol-Version", McpEndpoint.MODERN_VERSION,
                        "Mcp-Method", "tools/call", "Mcp-Name", "erd_get_table"));
        assertEquals(400, mismatch.statusCode());
        assertEquals(-32020, body(mismatch).path("error").path("code").asInt());
    }

    @Test
    @DisplayName("modern: 未対応の版は 400 + -32022 で対応版を列挙する")
    void modernUnsupportedVersion() throws Exception {
        enableMcp(false);
        var request = modern("tools/list", null);
        ((com.fasterxml.jackson.databind.node.ObjectNode) request.path("params").path("_meta"))
                .put("io.modelcontextprotocol/protocolVersion", "1900-01-01");
        HttpResponse<String> res = mcp(mcpToken, request,
                Map.of("MCP-Protocol-Version", "1900-01-01", "Mcp-Method", "tools/list"));
        assertEquals(400, res.statusCode());
        JsonNode error = body(res).path("error");
        assertEquals(-32022, error.path("code").asInt());
        assertTrue(error.path("data").path("supported").toString().contains(McpEndpoint.MODERN_VERSION));
    }

    @Test
    @DisplayName("modern: 未知のメソッドは 404 + -32601")
    void modernUnknownMethod() throws Exception {
        enableMcp(false);
        HttpResponse<String> res = mcp(mcpToken, modern("resources/list", null),
                Map.of("MCP-Protocol-Version", McpEndpoint.MODERN_VERSION,
                        "Mcp-Method", "resources/list"));
        assertEquals(404, res.statusCode());
        assertEquals(-32601, body(res).path("error").path("code").asInt());
    }

    @Test
    @DisplayName("通知（id なし）は 202 を返す")
    void notificationAccepted() throws Exception {
        enableMcp(false);
        var request = mapper.createObjectNode();
        request.put("jsonrpc", "2.0");
        request.put("method", "notifications/initialized");
        assertEquals(202, mcp(mcpToken, request, Map.of()).statusCode());
    }

    // ------------------------------------------------------------------ 小道具

    /** MCP を有効化してトークンを発行する（画面が行う操作と同じ API を通す）。 */
    private void enableMcp(boolean write) throws Exception {
        String body = "{\"enabled\":true,\"write\":" + write + ",\"token\":\"issue\"}";
        HttpRequest req = HttpRequest.newBuilder(
                        URI.create(origin + "/__erd/mcp/settings?t=" + SESSION_TOKEN))
                .header("Content-Type", "application/json")
                .method("PUT", HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        assertEquals(200, res.statusCode(), res.body());
        JsonNode json = mapper.readTree(res.body());
        mcpToken = json.path("issuedToken").asText();
        assertFalse(mcpToken.isEmpty(), "トークンが発行されていない: " + res.body());
        assertFalse(json.path("tokenHint").asText().equals(mcpToken), "伏字になっていない");
    }

    private HttpResponse<String> mcp(String bearer, JsonNode request, Map<String, String> headers)
            throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(origin + "/__erd/mcp"))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(request.toString(), StandardCharsets.UTF_8));
        if (bearer != null) req.header("Authorization", "Bearer " + bearer);
        headers.forEach(req::header);
        return http.send(req.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private com.fasterxml.jackson.databind.node.ObjectNode legacy(String method, JsonNode params) {
        var request = mapper.createObjectNode();
        request.put("jsonrpc", "2.0");
        request.put("id", 1);
        request.put("method", method);
        request.set("params", params == null ? mapper.createObjectNode() : params);
        return request;
    }

    private com.fasterxml.jackson.databind.node.ObjectNode call(String tool, JsonNode arguments) {
        var params = mapper.createObjectNode();
        params.put("name", tool);
        params.set("arguments", arguments);
        return legacy("tools/call", params);
    }

    /** modern は params._meta に版を載せる（これが世代の判定材料になる）。 */
    private com.fasterxml.jackson.databind.node.ObjectNode modern(String method, JsonNode params) {
        var request = legacy(method, params);
        var meta = ((com.fasterxml.jackson.databind.node.ObjectNode) request.path("params"))
                .putObject("_meta");
        meta.put("io.modelcontextprotocol/protocolVersion", McpEndpoint.MODERN_VERSION);
        meta.putObject("io.modelcontextprotocol/clientInfo")
                .put("name", "test").put("version", "1.0");
        meta.putObject("io.modelcontextprotocol/clientCapabilities");
        return request;
    }

    private JsonNode body(HttpResponse<String> res) throws Exception {
        return mapper.readTree(res.body());
    }

    /** 200 であることを確かめて result を返す。 */
    private JsonNode ok(HttpResponse<String> res) throws Exception {
        assertEquals(200, res.statusCode(), res.body());
        JsonNode json = body(res);
        assertFalse(json.has("error"), "JSON-RPC error が返っている: " + res.body());
        return json.path("result");
    }
}
