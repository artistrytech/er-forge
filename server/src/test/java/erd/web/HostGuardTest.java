package erd.web;

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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code Host} 検証（DNS リバインディング対策。§8.5 / Q-01 詳細設計 T-2）。
 *
 * <p><b>ここは落とすと dev 環境が丸ごと動かなくなる。</b> vite dev サーバーは
 * {@code changeOrigin: false} でプロキシするため、Java サーバーに届く {@code Host} は
 * {@code localhost:5173}（vite 自身のポート）のままである。「自分のポートと完全一致」で
 * 判定する実装に変えられていないことを、このテストで固定する。
 */
class HostGuardTest {

    private static final String TOKEN = "test-token";
    private final HttpClient http = HttpClient.newHttpClient();

    @Test
    @DisplayName("ホスト名だけを見る: ループバックは通し、外部ドメインは弾く")
    void hostNameOnly() {
        assertTrue(Guards.isLocalHost("127.0.0.1:5321"));
        assertTrue(Guards.isLocalHost("localhost:5173"), "dev の vite プロキシ（ポートが違う）");
        assertTrue(Guards.isLocalHost("localhost"), "ポートなし");
        assertTrue(Guards.isLocalHost("LocalHost:5321"), "大文字小文字は無視する");
        assertTrue(Guards.isLocalHost("[::1]:5321"), "IPv6 は角括弧を外して判定する");
        assertTrue(Guards.isLocalHost("[::1]"));

        assertFalse(Guards.isLocalHost("evil.example.com"), "DNS リバインディングの Host");
        assertFalse(Guards.isLocalHost("evil.example.com:5321"));
        assertFalse(Guards.isLocalHost("127.0.0.1.evil.example.com"), "前方一致で通してはならない");
        assertFalse(Guards.isLocalHost("localhost.evil.example.com"));
        assertFalse(Guards.isLocalHost(null));
        assertFalse(Guards.isLocalHost(""));
    }

    @Test
    @DisplayName("HTTP: 127.0.0.1 と localhost は通り、外部ドメインの Host は 403")
    void overHttp(@TempDir Path tmp) throws Exception {
        Path root = tmp.resolve("erd");
        Files.createDirectories(root);
        WebServer server = new WebServer(root, TOKEN);
        int port = server.start(5392);
        try {
            String origin = "http://127.0.0.1:" + port;

            // 既定（Host: 127.0.0.1:<port>）は通る
            assertEquals(200, get(origin + "/__erd/health", null).statusCode());

            // dev の vite プロキシ相当。ポートが違っても通らなければならない
            assertEquals(200, get(origin + "/__erd/health", "localhost:5173").statusCode(),
                    "vite dev（changeOrigin: false）からのリクエストが 403 になっている");

            // DNS リバインディング。トークンの有無によらず、Host の時点で弾く
            assertEquals(403, get(origin + "/__erd/health", "evil.example.com").statusCode());
            assertEquals(403,
                    get(origin + "/workspaces.js?t=" + TOKEN, "evil.example.com").statusCode(),
                    "正しいトークンを持っていても Host で弾く");
        } finally {
            server.stop();
        }
    }

    /**
     * {@code Host} は JDK の HttpClient では既定で設定できない制限ヘッダである。
     * テスト JVM に {@code jdk.httpclient.allowRestrictedHeaders=host} を渡して解除している
     * （{@code build.gradle.kts} の {@code tasks.test}）。
     */
    private HttpResponse<String> get(String url, String host) throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(url)).GET();
        if (host != null) req.header("Host", host);
        return http.send(req.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }
}
