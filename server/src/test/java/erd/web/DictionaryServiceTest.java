package erd.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DictionaryServiceTest {

    private final ObjectMapper json = new ObjectMapper();
    private final DictionaryService service = new DictionaryService();

    @TempDir
    Path tmp;

    private Path dataDir;

    @BeforeEach
    void setup() throws Exception {
        dataDir = tmp.resolve("data");
        Files.createDirectories(dataDir);
        Files.writeString(dataDir.resolve("dictionary.js"), """
                ERD.dictionary({
                  columns: {
                    created_at: { displayName: "作成日時", tags: ["監査"], color: "muted" },
                  },
                  futureKey: 1,
                });
                """, StandardCharsets.UTF_8);
    }

    private String putBody(String columns) {
        return "{ \"baseHash\": \"" + service.baseHash(dataDir) + "\", \"columns\": " + columns + " }";
    }

    // 全体置換 + 空エントリの除去（P §1.1: 全フィールドが空 = キー削除）。unknown キーは引き継がれる
    @Test
    void putReplacesWholeDictionary() throws Exception {
        var body = json.readTree(putBody("""
                { "id": { "displayName": "ID" },
                  "created_at": { "displayName": "登録日時" },
                  "blank": { "displayName": "", "tags": [], "color": "" } }
                """));
        var outcome = service.put(dataDir, body);

        assertInstanceOf(DictionaryService.Ok.class, outcome);
        String saved = Files.readString(dataDir.resolve("dictionary.js"), StandardCharsets.UTF_8);
        assertTrue(saved.contains("登録日時"));
        assertTrue(saved.contains("ID"));
        assertFalse(saved.contains("blank"));
        assertTrue(saved.contains("futureKey")); // 前方互換キーの保持
    }

    // タグ・色だけのエントリは「未設定」ではない（論理名が空でも残す）
    @Test
    void keepsEntryWithOnlyTagsOrColor() throws Exception {
        var body = json.readTree(putBody("""
                { "status": { "displayName": "", "tags": [" 区分 ", "区分"], "color": "blue" } }
                """));
        assertInstanceOf(DictionaryService.Ok.class, service.put(dataDir, body));

        String saved = Files.readString(dataDir.resolve("dictionary.js"), StandardCharsets.UTF_8);
        // 前後空白の除去と重複除去（大小無視）はサーバー側でも掛かる
        assertTrue(saved.contains("status: { tags: [\"区分\"], color: \"blue\" }"), saved);
    }

    // 未知の色トークン・壊れたタグは 422（テーブル保存と同じ規則。P-12 / P-13）
    @Test
    void rejectsUnknownColorAndBrokenTag() throws Exception {
        var body = json.readTree(putBody("""
                { "id": { "displayName": "ID", "color": "#ff0000" },
                  "status": { "displayName": "状態", "tags": ["a,b"] } }
                """));
        var outcome = service.put(dataDir, body);

        var invalid = assertInstanceOf(DictionaryService.Invalid.class, outcome);
        assertEquals(2, invalid.errors().size());
        assertEquals("columns.id.color", invalid.errors().get(0).path());
        assertEquals("UNKNOWN_COLOR", invalid.errors().get(0).code());
        assertEquals("columns.status.tags[0]", invalid.errors().get(1).path());
        // 拒否時は書き換えない
        assertTrue(Files.readString(dataDir.resolve("dictionary.js"), StandardCharsets.UTF_8)
                .contains("作成日時"));
    }

    @Test
    void staleBaseHashRejectsWrite() throws Exception {
        byte[] before = Files.readAllBytes(dataDir.resolve("dictionary.js"));
        var body = json.readTree("""
                { "baseHash": "sha256:0000", "columns": { "id": "ID" } }
                """);
        var outcome = service.put(dataDir, body);

        assertInstanceOf(DictionaryService.Stale.class, outcome);
        org.junit.jupiter.api.Assertions.assertArrayEquals(
                before, Files.readAllBytes(dataDir.resolve("dictionary.js")));
    }

    // ファイルが無い状態: baseHash は空文字、空文字のまま PUT すれば新規作成できる
    @Test
    void missingFileIsCreatable() throws Exception {
        Files.delete(dataDir.resolve("dictionary.js"));
        assertEquals("", service.baseHash(dataDir));

        var body = json.readTree("""
                { "baseHash": "", "columns": { "id": { "displayName": "ID" } } }
                """);
        assertInstanceOf(DictionaryService.Ok.class, service.put(dataDir, body));
        assertTrue(Files.isRegularFile(dataDir.resolve("dictionary.js")));
    }
}
