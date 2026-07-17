package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import erd.core.diff.PatternList;
import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.model.ProjectConfig;

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
 * プロジェクト設定 = テーブル無視リスト（K-15 / §5.4 / §9.4）。
 *
 * <p>{@code data/config.js} は human-owned。逆生成はこのファイルを<b>読むが書き換えない</b>。
 * 更新後、次回の逆生成から新しい無視リストが有効になる（既存のスキーマファイルを遡って
 * 削除することはない）。
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

    /** @param body { baseHash, force, ignoreTables: [...] } */
    Outcome put(Path dataDir, JsonNode body) {
        Path file = dataDir.resolve("config.js");
        String currentHash = Files.isRegularFile(file) ? Hashes.sha256(file) : null;
        boolean force = body.path("force").asBoolean(false);
        String baseHash = body.path("baseHash").asText("");
        if (!force && currentHash != null && !currentHash.equals(baseHash)) {
            return new Stale(currentHash);
        }

        JsonNode list = body.path("ignoreTables");
        if (!list.isArray()) {
            return new Invalid("ignoreTables must be an array");
        }
        List<String> patterns = new ArrayList<>();
        for (JsonNode n : list) {
            String p = n.asText("").trim();
            if (!p.isEmpty()) patterns.add(p);
        }
        // 不正な正規表現はここで弾く（黙って全マッチする無視リストを作らせない。T-11b）
        PatternList compiled = PatternList.of(patterns);
        if (!compiled.warnings().isEmpty()) {
            return new Invalid(String.join(" / ", compiled.warnings()));
        }

        ProjectConfig existing = read(dataDir);
        String content = printer.printConfig(new ProjectConfig(patterns, existing.unknown()));
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
