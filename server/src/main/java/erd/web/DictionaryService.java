package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.model.Dictionary;
import erd.core.model.DictionaryColumn;
import erd.core.model.MetaRules;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * カラムの共通設定（横断辞書）の一括更新（P-03 / §2.4）。
 *
 * <p>辞書は数百行のフラットなマップであり、全体を1回の PUT で置換する。
 * 保存後の index.js 再生成は不要（辞書はビューアが直接読む。P §4.3）。
 * 辞書のタグは {@code tagsUsed} に載せない代わりに、ビューアが辞書を直接読んで
 * タグ入力の候補に足す。
 */
public final class DictionaryService {

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();

    public sealed interface Outcome permits Ok, Stale, BadRequest, Invalid {}

    public record Ok(String newHash, Map<String, String> writtenFiles) implements Outcome {}

    public record Stale(String currentHash) implements Outcome {}

    /** リクエストの形が想定外（400）。 */
    public record BadRequest(String message) implements Outcome {}

    /** 値の検証で落ちた（422）。テーブル保存と同じ形式で返す。 */
    public record Invalid(List<Issue> errors) implements Outcome {}

    /** ファイルが無い場合は空文字（クライアントはそのまま baseHash として送り返す）。 */
    public String baseHash(Path dataDir) {
        Path file = dataDir.resolve("dictionary.js");
        return Files.isRegularFile(file) ? Hashes.sha256(file) : "";
    }

    /**
     * @param body { baseHash, force, columns: { 物理名: { displayName, tags, color } } }
     */
    public Outcome put(Path dataDir, JsonNode body) {
        Path file = dataDir.resolve("dictionary.js");
        String currentHash = "";
        Dictionary existing = Dictionary.EMPTY;
        if (Files.isRegularFile(file)) {
            byte[] current;
            try {
                current = Files.readAllBytes(file);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            currentHash = Hashes.sha256(current);
            existing = parser.parseDictionary(new String(current, StandardCharsets.UTF_8)).value();
        }
        boolean force = body.path("force").asBoolean(false);
        if (!force && !currentHash.equals(body.path("baseHash").asText(""))) {
            return new Stale(currentHash);
        }

        JsonNode columnsNode = body.path("columns");
        if (!columnsNode.isObject()) {
            return new BadRequest("columns object is required");
        }
        Map<String, DictionaryColumn> columns = new LinkedHashMap<>();
        List<Issue> errors = new ArrayList<>();
        for (Iterator<String> it = columnsNode.fieldNames(); it.hasNext(); ) {
            String key = it.next();
            if (key.isEmpty()) continue;
            JsonNode entryNode = columnsNode.get(key);
            DictionaryColumn entry = readEntry(entryNode, existing.columns().get(key));
            // 全フィールドが空 = 「未設定」= キー削除（P §1.1）。タグ・色だけのエントリは残す
            if (entry.isEmpty()) continue;
            Issue.validateTags("columns." + key + ".tags", entry.tags(), errors);
            Issue.validateColor("columns." + key + ".color", entry.color(), errors);
            columns.put(key, entry);
        }
        if (!errors.isEmpty()) {
            return new Invalid(List.copyOf(errors));
        }

        // unknown（前方互換キー）は既存ファイルから引き継ぐ
        String content = printer.printDictionary(new Dictionary(columns, existing.unknown()));
        String newHash = Hashes.sha256(content.getBytes(StandardCharsets.UTF_8));
        Map<String, String> written = new LinkedHashMap<>();
        try {
            if (!newHash.equals(currentHash)) {
                FileWrites.writeAtomic(file, content);
                written.put("dictionary.js", newHash);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return new Ok(newHash, written);
    }

    /**
     * 1エントリの読み取りと正規化。エントリ単位の前方互換キーは既存ファイルから引き継ぐ
     * （クライアントは知らないキーを送り返せないため、ここで拾わないと保存のたびに消える）。
     */
    private static DictionaryColumn readEntry(JsonNode node, DictionaryColumn old) {
        Map<String, JsonNode> unknown = old == null ? Map.of() : old.unknown();
        String displayName = "";
        List<String> tags = List.of();
        String color = null;
        if (node.isTextual()) {
            displayName = node.asText();
        } else if (node.isObject()) {
            displayName = node.path("displayName").asText("");
            color = MetaRules.normalizeColor(node.path("color").asText(""));
            List<String> raw = new ArrayList<>();
            node.path("tags").forEach(t -> raw.add(t.asText("")));
            tags = MetaRules.normalizeTags(raw);
        }
        return new DictionaryColumn(displayName.trim(), tags, color, unknown);
    }
}
