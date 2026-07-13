package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.model.Dictionary;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * カラム論理名の横断辞書の一括更新（P-03 / §2.4）。
 *
 * <p>辞書は数百行のフラットなマップであり、全体を1回の PUT で置換する。
 * 保存後の index.js 再生成は不要（辞書はビューアが直接読む。P §4.3）。
 */
public final class DictionaryService {

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();

    public sealed interface Outcome permits Ok, Stale, Invalid {}

    public record Ok(String newHash, Map<String, String> writtenFiles) implements Outcome {}

    public record Stale(String currentHash) implements Outcome {}

    public record Invalid(String message) implements Outcome {}

    /** ファイルが無い場合は空文字（クライアントはそのまま baseHash として送り返す）。 */
    public String baseHash(Path dataDir) {
        Path file = dataDir.resolve("dictionary.js");
        return Files.isRegularFile(file) ? Hashes.sha256(file) : "";
    }

    /**
     * @param body { lockId, baseHash, force, columns: { 物理名: 論理名 } }
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
            return new Invalid("columns object is required");
        }
        Map<String, String> columns = new LinkedHashMap<>();
        for (Iterator<String> it = columnsNode.fieldNames(); it.hasNext(); ) {
            String key = it.next();
            String value = columnsNode.get(key).asText("");
            // 空の論理名は「未設定」= キー削除（P §1.1）。サーバー側でも落とす
            if (!key.isEmpty() && !value.isEmpty()) {
                columns.put(key, value);
            }
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
}
