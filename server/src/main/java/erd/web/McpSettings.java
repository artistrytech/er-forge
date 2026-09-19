package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * MCP の設定（Q-01）。{@code erd/.local/mcp.json}（Git 管理外）。
 *
 * <p><b>全ワークスペース共通</b>である（接続情報のようにワークスペースごとに分けない）。
 * MCP クライアントは URL とヘッダを設定ファイルに固定して使うため、ワークスペースを
 * 切り替えるたびにトークンが変わると、利用者に設定を書き換えさせることになる。
 *
 * <p><b>{@code erd/config.js} に置いてはならない。</b> あちらは Git 管理対象であり、
 * トークンがコミットされる。{@code .local/} は配布 ZIP 同梱の {@code .gitignore} が除外する（§3.3）。
 *
 * <p>読み出しは毎回ディスクから行う。GUI で有効・無効を切り替えた直後から効かせるためで、
 * ファイルは数百バイトしかないためキャッシュする価値がない。
 */
final class McpSettings {

    private static final String FILE = "mcp.json";

    /** lastAccess の書き込み間隔。毎リクエスト書くとディスクを無駄に叩く。 */
    private static final long TOUCH_INTERVAL_MILLIS = 10_000;

    private final ObjectMapper mapper = new ObjectMapper();
    private final SecureRandom random = new SecureRandom();
    private volatile long lastTouchWrite;

    static Path file(Path root) {
        return root.resolve(WorkspaceStore.PRIVATE).resolve(FILE);
    }

    // ------------------------------------------------------------------ read

    /** 保存された設定。無ければ既定（無効・書き込み不可・トークンなし）。 */
    synchronized ObjectNode load(Path root) {
        Path path = file(root);
        if (Files.isRegularFile(path)) {
            try {
                JsonNode node = mapper.readTree(Files.readString(path, StandardCharsets.UTF_8));
                if (node.isObject()) return (ObjectNode) node;
            } catch (IOException | RuntimeException e) {
                // 壊れた設定で MCP が有効になるより、無効側に倒れるほうが安全
            }
        }
        return mapper.createObjectNode().put("enabled", false).put("write", false);
    }

    boolean enabled(Path root) {
        return load(root).path("enabled").asBoolean(false);
    }

    /** 書き込みツールを公開してよいか（Q-03 / Q-04）。有効化されていなければ常に false。 */
    boolean writeAllowed(Path root) {
        ObjectNode s = load(root);
        return s.path("enabled").asBoolean(false) && s.path("write").asBoolean(false);
    }

    /**
     * 提示されたトークンが一致するか。<b>固定時間比較</b>で行う
     * （ローカル専用だが、比較コストの差から情報が漏れる経路を作らない）。
     */
    boolean tokenMatches(Path root, String presented) {
        if (presented == null || presented.isEmpty()) return false;
        String stored = load(root).path("token").asText("");
        if (stored.isEmpty()) return false;
        return MessageDigest.isEqual(
                stored.getBytes(StandardCharsets.UTF_8),
                presented.getBytes(StandardCharsets.UTF_8));
    }

    // ----------------------------------------------------------------- write

    /**
     * 新しいトークンを発行して保存し、<b>生値を返す</b>（既存トークンは即失効する）。
     * 生値を返すのはこの瞬間だけで、以後は {@link #forClient} が伏字しか返さない。
     */
    synchronized String issueToken(Path root) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String token = HexFormat.of().formatHex(bytes);
        ObjectNode s = load(root);
        s.put("token", token);
        s.put("issuedAt", Instant.now().toString());
        save(root, s);
        return token;
    }

    synchronized void deleteToken(Path root) {
        ObjectNode s = load(root);
        s.remove("token");
        s.remove("issuedAt");
        save(root, s);
    }

    synchronized void setFlags(Path root, Boolean enabled, Boolean write) {
        ObjectNode s = load(root);
        if (enabled != null) s.put("enabled", enabled);
        if (write != null) s.put("write", write);
        save(root, s);
    }

    /**
     * 最終アクセスの記録（Q-01。意図しない利用に気づけるようにする）。
     *
     * <p><b>ツール呼び出しだけでなく、あらゆる MCP リクエストで記録する。</b>
     * 「クライアントは繋がっているのか」「どちらの世代で来ているのか」は、
     * 接続がうまくいかないときに最初に知りたいことであり、ツールを1回も呼ばずに
     * 終わる接続（initialize だけ通って tools/list で切れる等）もあるためである。
     *
     * <p>毎リクエスト書くとディスクを無駄に叩くため、一定間隔でだけ書く。
     * Git 管理外のファイルであり、取りこぼしても実害はない。
     *
     * @param label 呼ばれたツール名、またはツール以外のメソッド名
     * @param era   {@code "modern"} / {@code "legacy"}（§8.8 の世代）
     */
    void touch(Path root, String label, String era, boolean write) {
        long now = System.currentTimeMillis();
        if (now - lastTouchWrite < TOUCH_INTERVAL_MILLIS) return;
        lastTouchWrite = now;
        synchronized (this) {
            ObjectNode s = load(root);
            ObjectNode last = mapper.createObjectNode();
            last.put("at", Instant.now().toString());
            last.put("tool", label);
            last.put("era", era);
            last.put("write", write);
            s.set("lastAccess", last);
            save(root, s);
        }
    }

    private void save(Path root, ObjectNode settings) {
        try {
            Path path = file(root);
            Files.createDirectories(path.getParent());
            Path tmp = path.resolveSibling(FILE + ".tmp");
            Files.writeString(tmp, mapper.writerWithDefaultPrettyPrinter()
                    .writeValueAsString(settings) + "\n", StandardCharsets.UTF_8);
            Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ------------------------------------------------------------------- GUI

    /**
     * 画面へ返す形。<b>トークンの生値は含めない</b>（発行の応答だけが生値を返す）。
     * 末尾4文字だけをヒントとして返し、画面は「失くしたら再発行」と案内する。
     */
    Map<String, Object> forClient(Path root, int port) {
        ObjectNode s = load(root);
        String token = s.path("token").asText("");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", s.path("enabled").asBoolean(false));
        out.put("write", s.path("write").asBoolean(false));
        out.put("hasToken", !token.isEmpty());
        out.put("tokenHint", token.isEmpty() ? "" : "…" + token.substring(token.length() - 4));
        out.put("issuedAt", s.path("issuedAt").asText(""));
        out.put("lastAccess", s.has("lastAccess") ? s.get("lastAccess") : null);
        // 画面が設定スニペットを組み立てるために、実ポートを渡す（起動ごとに変わりうる）
        out.put("endpoint", "http://127.0.0.1:" + port + "/__erd/mcp");
        return out;
    }
}
