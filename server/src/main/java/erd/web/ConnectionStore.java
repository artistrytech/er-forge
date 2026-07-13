package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 接続情報の保存（K-05 / §8.5）。{@code .erd/connection.local.json}（Git 管理外）。
 *
 * <p>DB 認証情報は既定でメモリ保持のみ。<b>パスワードの保存は明示的なオプトイン</b>
 * （{@code savePassword: true}）でのみ行う。
 */
final class ConnectionStore {

    private static final String FILE = "connection.local.json";
    private final ObjectMapper mapper = new ObjectMapper();

    /** 保存された接続設定。無ければ null。 */
    ObjectNode load(Path erdDir) {
        Path file = erdDir.resolve(FILE);
        if (!Files.isRegularFile(file)) return null;
        try {
            JsonNode node = mapper.readTree(Files.readString(file, StandardCharsets.UTF_8));
            return node.isObject() ? (ObjectNode) node : null;
        } catch (IOException e) {
            return null;
        }
    }

    /** GUI へ返す形（パスワードは保存している場合のみ含める）。 */
    Map<String, Object> forClient(Path erdDir) {
        ObjectNode saved = load(erdDir);
        if (saved == null) return Map.of("saved", false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("saved", true);
        out.put("url", saved.path("url").asText(""));
        out.put("user", saved.path("user").asText(""));
        out.put("namespace", saved.path("namespace").asText(""));
        out.put("savePassword", saved.path("savePassword").asBoolean(false));
        out.put("password", saved.path("savePassword").asBoolean(false)
                ? saved.path("password").asText("") : "");
        out.put("properties", saved.has("properties") ? saved.get("properties")
                : mapper.createObjectNode());
        return out;
    }

    void save(Path erdDir, JsonNode body) {
        ObjectNode out = mapper.createObjectNode();
        out.put("url", body.path("url").asText(""));
        out.put("user", body.path("user").asText(""));
        out.put("namespace", body.path("namespace").asText(""));
        boolean savePassword = body.path("savePassword").asBoolean(false);
        out.put("savePassword", savePassword);
        if (savePassword) {
            out.put("password", body.path("password").asText(""));
        }
        out.set("properties", body.has("properties") ? body.get("properties")
                : mapper.createObjectNode());
        try {
            Files.createDirectories(erdDir);
            Path file = erdDir.resolve(FILE);
            Path tmp = file.resolveSibling(FILE + ".tmp");
            Files.write(tmp, mapper.writerWithDefaultPrettyPrinter()
                    .writeValueAsBytes(out));
            Files.move(tmp, file, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    void delete(Path erdDir) {
        try {
            Files.deleteIfExists(erdDir.resolve(FILE));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 前回の接続先 URL（G-4: 接続先が変わっていないかの判定に使う）。 */
    String lastUrl(Path erdDir) {
        ObjectNode saved = load(erdDir);
        if (saved == null) return null;
        String url = saved.path("url").asText("");
        return url.isEmpty() ? null : url;
    }
}
