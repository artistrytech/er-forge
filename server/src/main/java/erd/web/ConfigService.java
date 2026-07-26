package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import erd.core.diff.PatternList;
import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.model.DriverConfig;
import erd.core.model.ProjectConfig;
import erd.introspect.DriverDownloader;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code config.js} の読み書き（K-15 / §5.4 / §9.4）。human-owned。
 *
 * <p>2か所で使う。どちらも同じ書式であり、置き場所（引数の {@code dir}）だけが違う。
 * <ul>
 *   <li>{@code workspace-<id>/data/config.js} … テーブル無視リスト（ワークスペース単位）</li>
 *   <li>{@code erd/config.js} … JDBC ドライバ設定（全ワークスペース共通）</li>
 * </ul>
 *
 * <p>逆生成はこのファイルを<b>読むが書き換えない</b>。更新後、次回の逆生成から新しい
 * 無視リストが有効になる（既存のスキーマファイルを遡って削除することはない）。
 */
final class ConfigService {

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();

    sealed interface Outcome permits Ok, Stale, Invalid {}

    record Ok(String newHash, Map<String, String> writtenFiles) implements Outcome {}

    record Stale(String currentHash) implements Outcome {}

    record Invalid(String message) implements Outcome {}

    String baseHash(Path dataDir) {
        Path file = dataDir.resolve("config.js");
        return Files.isRegularFile(file) ? Hashes.sha256(file) : null;
    }

    ProjectConfig read(Path dataDir) {
        Path file = dataDir.resolve("config.js");
        if (!Files.isRegularFile(file)) return ProjectConfig.EMPTY;
        try {
            return parser.parseConfig(Files.readString(file, StandardCharsets.UTF_8)).value();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (RuntimeException e) {
            return ProjectConfig.EMPTY;
        }
    }

    /**
     * @param body { baseHash, force, ignoreTables?: [...], drivers?: { mavenRepository?, artifacts?: [...] } }
     *
     * <p>ignoreTables と drivers はどちらも任意で、本文に含まれるフィールドだけを更新する
     * （無視リスト画面とドライバ設定画面が別々に保存しても、相手の設定を消さない）。
     */
    Outcome put(Path dataDir, JsonNode body) {
        Path file = dataDir.resolve("config.js");
        String currentHash = Files.isRegularFile(file) ? Hashes.sha256(file) : null;
        boolean force = body.path("force").asBoolean(false);
        String baseHash = body.path("baseHash").asText("");
        if (!force && currentHash != null && !currentHash.equals(baseHash)) {
            return new Stale(currentHash);
        }

        ProjectConfig existing = read(dataDir);

        // ---- ignoreTables（任意。省略時は既存を維持） ----
        List<String> patterns;
        JsonNode list = body.get("ignoreTables");
        if (list == null || list.isNull()) {
            patterns = existing.ignoreTables();
        } else if (list.isArray()) {
            patterns = new ArrayList<>();
            for (JsonNode n : list) {
                String p = n.asText("").trim();
                if (!p.isEmpty()) patterns.add(p);
            }
            // 不正な正規表現はここで弾く（黙って全マッチする無視リストを作らせない。T-11b）
            PatternList compiled = PatternList.of(patterns);
            if (!compiled.warnings().isEmpty()) {
                return new Invalid(String.join(" / ", compiled.warnings()));
            }
        } else {
            return new Invalid("ignoreTables must be an array");
        }

        // ---- drivers（任意。省略時は既存を維持） ----
        DriverConfig drivers;
        JsonNode dn = body.get("drivers");
        if (dn == null || dn.isNull()) {
            drivers = existing.drivers();
        } else if (dn.isObject()) {
            String repo = dn.hasNonNull("mavenRepository") ? dn.get("mavenRepository").asText().trim() : null;
            if (repo != null && !repo.isEmpty() && DriverDownloader.normalizeRepository(repo) == null) {
                return new Invalid("mavenRepository must be an http(s) URL");
            }
            List<String> artifacts = new ArrayList<>();
            JsonNode arts = dn.get("artifacts");
            if (arts != null && arts.isArray()) {
                for (JsonNode n : arts) {
                    String a = n.asText("").trim();
                    if (a.isEmpty()) continue;
                    if (!DriverDownloader.isValidCoordinate(a)) {
                        return new Invalid("invalid driver coordinate: " + a
                                + " (expected group:artifact:version)");
                    }
                    artifacts.add(a);
                }
            }
            drivers = new DriverConfig(repo == null || repo.isEmpty() ? null : repo, artifacts);
        } else {
            return new Invalid("drivers must be an object");
        }

        // 未知キーはそのまま書き戻す（前方互換。§5.12）
        Map<String, JsonNode> unknown = new LinkedHashMap<>(existing.unknown());

        String content = printer.printConfig(new ProjectConfig(patterns, drivers, unknown));
        String newHash = Hashes.sha256(content.getBytes(StandardCharsets.UTF_8));
        Map<String, String> written = new LinkedHashMap<>();
        try {
            if (!newHash.equals(currentHash)) {
                FileWrites.writeAtomic(file, content);
                written.put("config.js", newHash);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return new Ok(newHash, written);
    }
}
