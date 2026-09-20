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

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
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
        // orders は user_id を持つ（論理外部制約のテストで users を参照させる）
        List<Column> columns = name.equals("orders")
                ? List.of(new Column("id", "int4", LogicalType.INT, false),
                        new Column("user_id", "int4", LogicalType.INT, true))
                : List.of(new Column("id", "int4", LogicalType.INT, false));
        return new Table("public." + name,
                new TableSchema(name, "public", null, columns,
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
    @DisplayName("公開範囲: 書き込み許可オフなら読み取り8種のみ。逆生成・接続情報・削除系は存在しない")
    void toolSurfaceIsBounded() throws Exception {
        enableMcp(false);
        List<String> names = toolNames();
        assertEquals(List.of("erd_list_workspaces", "erd_list_tables", "erd_get_table",
                "erd_list_relations", "erd_search", "erd_list_diagrams", "erd_get_diagram",
                "erd_get_dictionary"), names);

        enableMcp(true);
        List<String> withWrite = toolNames();
        assertTrue(withWrite.containsAll(McpWriteTools.NAMES), "書き込み許可で書き込みツールが出る: " + withWrite);
        for (String forbidden : List.of("introspect", "connection", "driver", "delete",
                "reset", "export", "workspace", "rename", "create_table")) {
            assertTrue(withWrite.stream().noneMatch(n -> n.contains(forbidden) && !n.equals("erd_list_workspaces")),
                    "出してはならないツールがある: " + forbidden + " / " + withWrite);
        }
    }

    // ------------------------------------------------------------ 書き込み（Q-03）

    @Test
    @DisplayName("INV-6: 書き込み許可オフでは、直接呼んでも Unknown tool")
    void writeRejectedWhenNotAllowed() throws Exception {
        enableMcp(false);
        var args = mapper.createObjectNode().put("tableId", "public.orders").put("displayName", "注文");
        HttpResponse<String> res = mcp(mcpToken, call("erd_set_table_meta", args), Map.of());
        assertEquals(200, res.statusCode());
        JsonNode error = body(res).path("error");
        assertEquals(-32602, error.path("code").asInt(), res.body());
        assertTrue(error.path("message").asText().contains("Unknown tool"), res.body());
        assertFalse(Files.readString(root.resolve("workspace-default/data/schema/public/orders.js"))
                .contains("注文"), "書き込まれてはならない");
    }

    @Test
    @DisplayName("INV-1: 物理情報のキーを混ぜたら isError で拒否し、1バイトも書かない")
    void physicalFieldsAreRejected() throws Exception {
        enableMcp(true);
        Path file = root.resolve("workspace-default/data/schema/public/orders.js");
        byte[] before = Files.readAllBytes(file);

        var column = mapper.createObjectNode().put("name", "user_id").put("type", "bigint");
        var args = mapper.createObjectNode().put("tableId", "public.orders");
        args.putArray("columns").add(column);
        JsonNode result = ok(mcp(mcpToken, call("erd_set_table_meta", args), Map.of()));
        assertTrue(result.path("isError").asBoolean(), result.toString());
        String text = result.path("content").get(0).path("text").asText();
        assertTrue(text.contains("type"), "何が駄目かを言う: " + text);
        assertTrue(text.contains("database"), "理由を言う: " + text);
        assertArrayEquals(before, Files.readAllBytes(file), "ファイルが変わっている");

        // トップレベルでも同じ
        var top = mapper.createObjectNode().put("tableId", "public.orders").put("primaryKey", "id");
        JsonNode r2 = ok(mcp(mcpToken, call("erd_set_table_meta", top), Map.of()));
        assertTrue(r2.path("isError").asBoolean());
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    @DisplayName("erd_set_table_meta: 部分更新で meta だけが変わり、index.js が再生成される")
    void setTableMeta() throws Exception {
        enableMcp(true);
        var column = mapper.createObjectNode().put("name", "user_id").put("displayName", "ユーザーID");
        column.putArray("tags").add("fk");
        var args = mapper.createObjectNode().put("tableId", "public.orders")
                .put("displayName", "注文").put("notes", "受注の親");
        args.putArray("tags").add("core");
        args.putArray("columns").add(column);
        JsonNode result = ok(mcp(mcpToken, call("erd_set_table_meta", args), Map.of()));
        assertFalse(result.path("isError").asBoolean(), result.toString());
        String text = result.path("content").get(0).path("text").asText();
        assertTrue(text.contains("index.js"), "index.js が再生成されていない: " + text);

        // 読み返して反映を確かめる（辞書ではなくカラム個別の論理名）
        JsonNode table = ok(mcp(mcpToken,
                call("erd_get_table", mapper.createObjectNode().put("tableId", "public.orders")), Map.of()));
        JsonNode t = mapper.readTree(table.path("content").get(0).path("text").asText());
        assertEquals("注文", t.path("displayName").asText());
        assertEquals("受注の親", t.path("notes").asText());
        JsonNode userId = t.path("columns").get(1);
        assertEquals("user_id", userId.path("name").asText());
        assertEquals("ユーザーID", userId.path("displayName").asText());
        assertEquals("column", userId.path("displayNameSource").asText());
        // 物理情報は無傷
        assertEquals("int4", userId.path("type").asText());

        // 省略した項目は変わらない（displayName を渡さずに notes だけ消す）
        var patch = mapper.createObjectNode().put("tableId", "public.orders");
        patch.putNull("notes");
        ok(mcp(mcpToken, call("erd_set_table_meta", patch), Map.of()));
        JsonNode again = mapper.readTree(ok(mcp(mcpToken,
                call("erd_get_table", mapper.createObjectNode().put("tableId", "public.orders")), Map.of()))
                .path("content").get(0).path("text").asText());
        assertEquals("注文", again.path("displayName").asText(), "省略した displayName が消えた");
        assertFalse(again.has("notes"), "null で消した notes が残っている");
    }

    @Test
    @DisplayName("erd_set_logical_constraints: 論理外部制約が index.js のリレーションに現れ、不正な参照先は拒否される")
    void setLogicalConstraints() throws Exception {
        enableMcp(true);
        var lfk = mapper.createObjectNode().put("name", "lfk_orders_user").put("references", "public.users");
        lfk.putArray("columns").add("user_id");
        lfk.putArray("referencedColumns").add("id");
        var args = mapper.createObjectNode().put("tableId", "public.orders");
        args.putArray("logicalForeignKeys").add(lfk);
        JsonNode result = ok(mcp(mcpToken, call("erd_set_logical_constraints", args), Map.of()));
        assertFalse(result.path("isError").asBoolean(), result.toString());

        JsonNode rels = mapper.readTree(ok(mcp(mcpToken,
                call("erd_list_relations", mapper.createObjectNode().put("tableId", "public.orders")), Map.of()))
                .path("content").get(0).path("text").asText());
        assertEquals(1, rels.path("relations").size(), rels.toString());
        JsonNode r = rels.path("relations").get(0);
        assertEquals("logical", r.path("kind").asText());
        assertEquals("public.orders#lfk:lfk_orders_user", r.path("id").asText());
        assertEquals("public.users", r.path("to").asText());

        // 参照先が無い → P-08 の検証で isError（ファイルは書かれない）
        Path file = root.resolve("workspace-default/data/schema/public/orders.js");
        byte[] before = Files.readAllBytes(file);
        var bad = mapper.createObjectNode().put("name", "lfk_bad").put("references", "public.nope");
        bad.putArray("columns").add("user_id");
        bad.putArray("referencedColumns").add("id");
        var badArgs = mapper.createObjectNode().put("tableId", "public.orders");
        badArgs.putArray("logicalForeignKeys").add(bad);
        JsonNode rejected = ok(mcp(mcpToken, call("erd_set_logical_constraints", badArgs), Map.of()));
        assertTrue(rejected.path("isError").asBoolean(), rejected.toString());
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    @DisplayName("erd_set_dictionary_entry / erd_set_ignore_tables: 辞書と無視リストを書ける")
    void setDictionaryAndIgnoreTables() throws Exception {
        enableMcp(true);
        var entry = mapper.createObjectNode().put("column", "id").put("displayName", "ID");
        assertFalse(ok(mcp(mcpToken, call("erd_set_dictionary_entry", entry), Map.of()))
                .path("isError").asBoolean());
        JsonNode dict = mapper.readTree(ok(mcp(mcpToken,
                call("erd_get_dictionary", mapper.createObjectNode()), Map.of()))
                .path("content").get(0).path("text").asText());
        assertEquals("ID", dict.path("columns").get(0).path("displayName").asText(), dict.toString());
        // 辞書経由で解決されたことが erd_get_table で分かる
        JsonNode t = mapper.readTree(ok(mcp(mcpToken,
                call("erd_get_table", mapper.createObjectNode().put("tableId", "public.users")), Map.of()))
                .path("content").get(0).path("text").asText());
        assertEquals("dictionary", t.path("columns").get(0).path("displayNameSource").asText());

        var ignore = mapper.createObjectNode();
        ignore.putArray("patterns").add("public.tmp_*").add("public.flyway_schema_history");
        assertFalse(ok(mcp(mcpToken, call("erd_set_ignore_tables", ignore), Map.of()))
                .path("isError").asBoolean());
        String config = Files.readString(root.resolve("workspace-default/data/config.js"));
        assertTrue(config.contains("public.tmp_*"), config);

        // 壊れた正規表現は拒否（黙って全マッチする無視リストを作らせない）
        var broken = mapper.createObjectNode();
        broken.putArray("patterns").add("/[unclosed/");
        assertTrue(ok(mcp(mcpToken, call("erd_set_ignore_tables", broken), Map.of()))
                .path("isError").asBoolean());
    }

    @Test
    @DisplayName("Q-06: 書き込み前に data/** のバックアップを取り、短時間の連続書き込みでは増やさない")
    void backupBeforeWrite() throws Exception {
        enableMcp(true);
        Path backups = root.resolve(".local/workspace-default/backup");
        assertFalse(Files.isDirectory(backups), "書き込み前にバックアップがある");

        var args = mapper.createObjectNode().put("tableId", "public.orders").put("displayName", "注文");
        ok(mcp(mcpToken, call("erd_set_table_meta", args), Map.of()));
        assertEquals(1, countDirs(backups), "最初の書き込みで1世代できる");
        assertTrue(Files.isRegularFile(backups.resolve(firstDir(backups)).resolve("schema/public/orders.js")));

        ok(mcp(mcpToken, call("erd_set_table_meta", args.put("notes", "x")), Map.of()));
        assertEquals(1, countDirs(backups), "直後の書き込みでは増えない");
    }

    private List<String> toolNames() throws Exception {
        JsonNode result = ok(mcp(mcpToken, legacy("tools/list", null), Map.of()));
        List<String> names = new ArrayList<>();
        result.path("tools").forEach(t -> names.add(t.path("name").asText()));
        return names;
    }

    private static int countDirs(Path dir) throws Exception {
        if (!Files.isDirectory(dir)) return 0;
        try (var s = Files.list(dir)) {
            return (int) s.filter(Files::isDirectory).count();
        }
    }

    private static String firstDir(Path dir) throws Exception {
        try (var s = Files.list(dir)) {
            return s.filter(Files::isDirectory).findFirst().orElseThrow().getFileName().toString();
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
    @DisplayName("modern: server/discover と tools/list にキャッシュヒントが必須")
    void modernCacheHints() throws Exception {
        enableMcp(false);
        // これが欠けるとクライアントのスキーマ検証で落ち、
        // 「接続はできているのにツールが取れない」という分かりにくい壊れ方をする
        for (String method : List.of("server/discover", "tools/list")) {
            JsonNode result = ok(mcp(mcpToken, modern(method, null),
                    Map.of("MCP-Protocol-Version", McpEndpoint.MODERN_VERSION, "Mcp-Method", method)));
            assertEquals("complete", result.path("resultType").asText(), method);
            assertTrue(result.path("ttlMs").isInt(), method + ": ttlMs が整数でない");
            assertTrue(result.path("ttlMs").asInt() >= 0, method + ": ttlMs は 0 以上");
            assertTrue(List.of("public", "private").contains(result.path("cacheScope").asText()),
                    method + ": cacheScope は public / private のみ");
        }
    }

    @Test
    @DisplayName("キャッシュヒントは対象の結果にだけ付ける（tools/call と legacy には付けない）")
    void cacheHintsOnlyWhereRequired() throws Exception {
        enableMcp(false);
        var params = mapper.createObjectNode();
        params.put("name", "erd_list_workspaces");
        params.set("arguments", mapper.createObjectNode());
        JsonNode call = ok(mcp(mcpToken, modern("tools/call", params),
                Map.of("MCP-Protocol-Version", McpEndpoint.MODERN_VERSION,
                        "Mcp-Method", "tools/call", "Mcp-Name", "erd_list_workspaces")));
        assertFalse(call.has("ttlMs"), "tools/call はキャッシュ対象ではない");

        JsonNode legacyList = ok(mcp(mcpToken, legacy("tools/list", null), Map.of()));
        assertFalse(legacyList.has("ttlMs"), "legacy にキャッシュヒントの概念は無い");
        assertFalse(legacyList.has("resultType"), "legacy に resultType は無い");
    }

    @Test
    @DisplayName("最終アクセスに世代（modern / legacy）が残る")
    void lastAccessRecordsEra() throws Exception {
        enableMcp(false);
        // ツールを呼ばずに終わる接続もあるため、tools/list でも記録されなければならない
        mcp(mcpToken, modern("tools/list", null),
                Map.of("MCP-Protocol-Version", McpEndpoint.MODERN_VERSION, "Mcp-Method", "tools/list"));

        HttpRequest req = HttpRequest.newBuilder(
                URI.create(origin + "/__erd/mcp/settings?t=" + SESSION_TOKEN)).GET().build();
        JsonNode settings = mapper.readTree(
                http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body());
        assertEquals("modern", settings.path("lastAccess").path("era").asText());
        assertEquals("tools/list", settings.path("lastAccess").path("tool").asText());
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
