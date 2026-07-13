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
                    created_at: "作成日時",
                  },
                  futureKey: 1,
                });
                """, StandardCharsets.UTF_8);
    }

    // 全体置換 + 空値の除去（P §1.1: 空 = キー削除）。unknown キーは引き継がれる
    @Test
    void putReplacesWholeDictionary() throws Exception {
        var body = json.readTree("""
                { "lockId": "l-1", "baseHash": "%s",
                  "columns": { "id": "ID", "created_at": "登録日時", "blank": "" } }
                """.formatted(service.baseHash(dataDir)));
        var outcome = service.put(dataDir, body);

        assertInstanceOf(DictionaryService.Ok.class, outcome);
        String saved = Files.readString(dataDir.resolve("dictionary.js"), StandardCharsets.UTF_8);
        assertTrue(saved.contains("登録日時"));
        assertTrue(saved.contains("\"ID\"") || saved.contains("ID"));
        assertFalse(saved.contains("blank"));
        assertTrue(saved.contains("futureKey")); // 前方互換キーの保持
    }

    @Test
    void staleBaseHashRejectsWrite() throws Exception {
        byte[] before = Files.readAllBytes(dataDir.resolve("dictionary.js"));
        var body = json.readTree("""
                { "lockId": "l-1", "baseHash": "sha256:0000", "columns": { "id": "ID" } }
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
                { "lockId": "l-1", "baseHash": "", "columns": { "id": "ID" } }
                """);
        assertInstanceOf(DictionaryService.Ok.class, service.put(dataDir, body));
        assertTrue(Files.isRegularFile(dataDir.resolve("dictionary.js")));
    }
}
