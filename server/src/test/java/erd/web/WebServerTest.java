package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ワークスペースの API とパス形（{@code /workspace-<id>/data/**}・{@code /__erd/w/<id>/...}）の検証。
 *
 * <p>静的モード（file://）とサーバーモードで<b>同じ相対パス</b>でデータを読む（§4.3）ため、
 * 配信 URL の形はビューアの実装と一対一で対応する。ここがずれると静的モードだけが壊れる。
 */
class WebServerTest {

    private static final String TOKEN = "test-token";
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newHttpClient();

    private interface Body {
        void run(String origin) throws Exception;
    }

    /** 配布物と同じ配置（`<repo>/erd/` の下がサーバーのルート。個人データは `erd/.local/`）。 */
    private static Path erdRoot(Path tmp) throws Exception {
        Path root = tmp.resolve("erd");
        Files.createDirectories(root);
        return root;
    }

    private void withServer(Path root, Body body) throws Exception {
        WebServer server = new WebServer(root, TOKEN);
        int port = server.start(5390);
        try {
            body.run("http://127.0.0.1:" + port);
        } finally {
            server.stop();
        }
    }

    private HttpResponse<String> send(String method, String url, String json) throws Exception {
        HttpRequest.BodyPublisher pub = json == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8);
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .header("Content-Type", "application/json")
                .method(method, pub)
                .build();
        return http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private String t(String origin, String path) {
        return origin + path + (path.contains("?") ? "&" : "?") + "t=" + TOKEN;
    }

    @Test
    @DisplayName("作成 → workspaces.js が生成され、data/** が workspace-<id>/data/ で配信される")
    void createAndServe(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        withServer(root, origin -> {
            HttpResponse<String> created = send("POST", t(origin, "/__erd/workspaces"),
                    "{\"id\":\"sales\",\"name\":\"販売管理\"}");
            assertEquals(200, created.statusCode());

            // レジストリ（静的モードはこれを <script> で読む）
            assertTrue(Files.isRegularFile(root.resolve("workspaces.js")));
            String registry = Files.readString(root.resolve("workspaces.js"), StandardCharsets.UTF_8);
            assertTrue(registry.contains("ERD.workspaces({"));
            assertTrue(registry.contains("{ id: \"sales\", name: \"販売管理\" },"));

            HttpResponse<String> served = send("GET", origin + "/workspaces.js", null);
            assertEquals(200, served.statusCode());
            assertTrue(served.body().contains("sales"));

            // データの静的配信（file:// と同じ相対パス）
            Path data = root.resolve("workspace-sales/data");
            Files.createDirectories(data);
            Files.writeString(data.resolve("manifest.js"), "ERD.manifest({ schemaVersion: 1 });\n");
            HttpResponse<String> manifest = send("GET", origin + "/workspace-sales/data/manifest.js", null);
            assertEquals(200, manifest.statusCode());
            assertTrue(manifest.body().contains("schemaVersion"));
            assertEquals("text/javascript; charset=utf-8", manifest.headers().firstValue("Content-Type").orElse(""));

            // 存在しないワークスペースは 404（ディレクトリを作らない）
            assertEquals(404, send("GET", origin + "/workspace-nope/data/manifest.js", null).statusCode());
            assertEquals(404, send("GET", t(origin, "/__erd/w/nope/project"), null).statusCode());
        });
    }

    @Test
    @DisplayName("ID・名前の検証と重複（大文字小文字を区別しない）")
    void validation(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        withServer(root, origin -> {
            assertEquals(400, send("POST", t(origin, "/__erd/workspaces"),
                    "{\"id\":\"bad id\",\"name\":\"x\"}").statusCode());
            assertEquals(400, send("POST", t(origin, "/__erd/workspaces"),
                    "{\"id\":\"ok\",\"name\":\"  \"}").statusCode());

            // ID 省略時は default
            HttpResponse<String> res = send("POST", t(origin, "/__erd/workspaces"), "{\"name\":\"既定\"}");
            assertEquals(200, res.statusCode());
            assertEquals("default", mapper.readTree(res.body()).path("id").asText());

            HttpResponse<String> dup = send("POST", t(origin, "/__erd/workspaces"),
                    "{\"id\":\"DEFAULT\",\"name\":\"別\"}");
            assertEquals(409, dup.statusCode());
            assertEquals("DUPLICATE_ID", mapper.readTree(dup.body()).path("code").asText());
        });
    }

    @Test
    @DisplayName("ID 変更はフォルダと .local/ を移し、削除は個人データごと消す")
    void renameAndDelete(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        withServer(root, origin -> {
            assertEquals(200, send("POST", t(origin, "/__erd/workspaces"),
                    "{\"id\":\"old\",\"name\":\"旧\"}").statusCode());
            Path privateDir = root.resolve(".local/workspace-old");
            Files.createDirectories(privateDir);
            Files.writeString(privateDir.resolve("connection.local.json"), "{}");
            Files.writeString(root.resolve("workspace-old/data/marker.js"), "// marker\n");

            HttpResponse<String> renamed = send("PATCH", t(origin, "/__erd/workspaces/old"),
                    "{\"id\":\"new\",\"name\":\"新\"}");
            assertEquals(200, renamed.statusCode());
            assertFalse(Files.exists(root.resolve("workspace-old")));
            assertTrue(Files.isRegularFile(root.resolve("workspace-new/data/marker.js")));
            assertTrue(Files.isRegularFile(
                    root.resolve(".local/workspace-new/connection.local.json")));
            assertTrue(Files.readString(root.resolve("workspaces.js"), StandardCharsets.UTF_8)
                    .contains("{ id: \"new\", name: \"新\" },"));

            assertEquals(200, send("DELETE", t(origin, "/__erd/workspaces/new"), null).statusCode());
            assertFalse(Files.exists(root.resolve("workspace-new")));
            assertFalse(Files.exists(root.resolve(".local/workspace-new")));
        });
    }

    @Test
    @DisplayName("データリセットは対象ワークスペースだけを空にし、config.js を残す")
    void resetKeepsWorkspace(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        withServer(root, origin -> {
            send("POST", t(origin, "/__erd/workspaces"), "{\"id\":\"a\",\"name\":\"A\"}");
            send("POST", t(origin, "/__erd/workspaces"), "{\"id\":\"b\",\"name\":\"B\"}");
            for (String id : new String[] {"a", "b"}) {
                Path data = root.resolve("workspace-" + id + "/data");
                Files.createDirectories(data.resolve("schema/public"));
                Files.writeString(data.resolve("manifest.js"), "ERD.manifest({ schemaVersion: 1 });\n");
                Files.writeString(data.resolve("config.js"), "ERD.config({});\n");
                Files.writeString(data.resolve("schema/public/users.js"), "// x\n");
            }

            assertEquals(200, send("POST", t(origin, "/__erd/w/a/reset"), "{}").statusCode());

            assertFalse(Files.exists(root.resolve("workspace-a/data/manifest.js")));
            assertFalse(Files.exists(root.resolve("workspace-a/data/schema")));
            assertTrue(Files.isRegularFile(root.resolve("workspace-a/data/config.js")));
            assertTrue(Files.isDirectory(root.resolve("workspace-a")));
            // 別ワークスペースには触れない
            assertTrue(Files.isRegularFile(root.resolve("workspace-b/data/manifest.js")));
            assertTrue(Files.isRegularFile(root.resolve("workspace-b/data/schema/public/users.js")));
        });
    }

    @Test
    @DisplayName("走査で見つかったワークスペースはレジストリに載る（Git で pull された場合）")
    void scanRebuildsRegistry(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        Files.createDirectories(root.resolve("workspace-pulled/data"));
        withServer(root, origin -> {
            HttpResponse<String> res = send("GET", t(origin, "/__erd/workspaces"), null);
            assertEquals(200, res.statusCode());
            JsonNode list = mapper.readTree(res.body()).path("workspaces");
            assertEquals(1, list.size());
            assertEquals("pulled", list.get(0).path("id").asText());
            // 名前が分からないので ID を表示名にする
            assertEquals("pulled", list.get(0).path("name").asText());
        });
    }

    @Test
    @DisplayName("トークンが無ければ書き込み API は 403")
    void tokenRequired(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        withServer(root, origin -> {
            assertEquals(403, send("POST", origin + "/__erd/workspaces",
                    "{\"id\":\"x\",\"name\":\"X\"}").statusCode());
            assertEquals(403, send("GET", origin + "/__erd/workspaces", null).statusCode());
            assertEquals(403, send("POST", origin + "/__erd/export/viewer", "{}").statusCode());
        });
    }

    @Test
    @DisplayName("A-11: 閲覧用 ZIP を返す（ファイル名は prefix 由来。CLI と同じ中身）")
    void exportsViewerZip(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        Files.writeString(root.resolve("index.html"), "<!doctype html>", StandardCharsets.UTF_8);
        Files.createDirectories(root.resolve("workspace-sales/data"));
        Files.writeString(root.resolve("workspace-sales/data/manifest.js"), "ERD.manifest({});\n");
        withServer(root, origin -> {
            HttpRequest req = HttpRequest.newBuilder(URI.create(t(origin, "/__erd/export/viewer")))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(
                            "{\"prefix\":\"売上 ER図\",\"workspaces\":[\"sales\"]}", StandardCharsets.UTF_8))
                    .build();
            HttpResponse<byte[]> res = http.send(req, HttpResponse.BodyHandlers.ofByteArray());

            assertEquals(200, res.statusCode());
            assertEquals("application/zip", res.headers().firstValue("Content-Type").orElse(""));
            // 日本語のファイル名は filename* 側で渡す（RFC 5987）
            String disposition = res.headers().firstValue("Content-Disposition").orElse("");
            assertTrue(disposition.contains("filename*=UTF-8''"), disposition);
            assertTrue(disposition.contains("%E5%A3%B2%E4%B8%8A"), disposition);

            List<String> names = new ArrayList<>();
            try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(res.body()))) {
                for (ZipEntry e = zip.getNextEntry(); e != null; e = zip.getNextEntry()) {
                    names.add(e.getName());
                }
            }
            assertEquals(List.of("index.html", "workspaces.js",
                    "workspace-sales/data/manifest.js"), names);

            // ファイル名にできない prefix は 400（サーバーが正。ビューア側の検査は即時表示のため）
            HttpResponse<String> bad = send("POST", t(origin, "/__erd/export/viewer"),
                    "{\"prefix\":\"a/b\"}");
            assertEquals(400, bad.statusCode());
            assertEquals("INVALID_PREFIX", mapper.readTree(bad.body()).path("code").asText());

            HttpResponse<String> unknown = send("POST", t(origin, "/__erd/export/viewer"),
                    "{\"workspaces\":[\"nope\"]}");
            assertEquals(400, unknown.statusCode());
            assertEquals("UNKNOWN_WORKSPACE", mapper.readTree(unknown.body()).path("code").asText());
        });
    }
}
