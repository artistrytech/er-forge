package erd.core.io;

import erd.core.model.LogicalType;
import erd.core.model.Table;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 読み込み時検証（Phase0 詳細設計 §3.2 / §3.3）。 */
class ParserValidationTest {

    private final DataFileParser parser = new DataFileParser();

    @Test
    @DisplayName("V-1: 必須キー（id / name / columns）が無いとエラー")
    void requiredKeys() {
        assertThrows(DataFileException.class, () ->
                parser.parseTable("ERD.table({\n  name: \"users\",\n  columns: [],\n});\n"));
        assertThrows(DataFileException.class, () ->
                parser.parseTable("ERD.table({\n  id: \"public.users\",\n  columns: [],\n});\n"));
        assertThrows(DataFileException.class, () ->
                parser.parseTable("ERD.table({\n  id: \"public.users\",\n  name: \"users\",\n});\n"));
    }

    @Test
    @DisplayName("V-2: 不明な logicalType は other にフォールバックして警告")
    void unknownLogicalType() {
        Parsed<Table> parsed = parser.parseTable("""
                ERD.table({
                  id: "public.t",
                  name: "t",
                  columns: [
                    { name: "id", type: "hyperint", logicalType: "hyperint", nullable: false },
                  ],
                });
                """);
        assertEquals(LogicalType.OTHER, parsed.value().schema().columns().get(0).logicalType());
        assertTrue(parsed.warnings().stream().anyMatch(w -> w.contains("hyperint")));
    }

    @Test
    @DisplayName("V-3: id と schema.name の不一致は警告（id を正とする）")
    void idMismatch() {
        Parsed<Table> parsed = parser.parseTable("""
                ERD.table({
                  id: "public.old_name",
                  name: "new_name",
                  schema: "public",
                  columns: [
                    { name: "id", type: "int4", logicalType: "int", nullable: false },
                  ],
                });
                """);
        assertEquals("public.old_name", parsed.value().id());
        assertTrue(parsed.warnings().stream().anyMatch(w -> w.contains("does not match")));
    }

    @Test
    @DisplayName("§3.2: ラッパの関数名が期待と異なればエラー")
    void wrongWrapper() {
        DataFileException e = assertThrows(DataFileException.class, () ->
                parser.parseTable("ERD.diagram({\n  id: \"x\",\n});\n"));
        assertTrue(e.getMessage().contains("ERD.table"));
    }

    @Test
    @DisplayName("§3.2: 複数の文・オブジェクト以外はエラー")
    void notASingleObject() {
        assertThrows(DataFileException.class, () ->
                parser.parseTable("ERD.table({}); ERD.table({});"));
        assertThrows(DataFileException.class, () ->
                parser.parseTable("ERD.table([1, 2]);"));
        assertThrows(DataFileException.class, () ->
                parser.parseTable("var x = 1;"));
    }

    @Test
    @DisplayName("緩和構文（シングルクォート・裸キー・末尾カンマ・コメント）を受け付ける")
    void lenientSyntax() {
        Parsed<Table> parsed = parser.parseTable("""
                ERD.table({
                  // コメントも許容する（書き込み時には残らない）
                  id: 'public.t',
                  name: 't',
                  columns: [
                    { name: 'id', type: 'int4', logicalType: 'int', nullable: false, },
                  ],
                });
                """);
        assertEquals("public.t", parsed.value().id());
    }
}
