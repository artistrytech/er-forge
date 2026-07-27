package erd.core.io;

import erd.core.fixtures.FixtureModels;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 書式規約（Phase0 詳細設計 §2）の個別検証。 */
class PrinterRulesTest {

    private final DataFilePrinter printer = new DataFilePrinter();

    @Test
    @DisplayName("T-4: 日本語をエスケープしない（INV-4）")
    void japaneseNotEscaped() {
        String out = printer.printTable(FixtureModels.usersTable());
        assertTrue(out.contains("ユーザーマスタ"), "日本語がそのまま出力されること");
        assertTrue(out.contains("所属組織ID"));
        assertFalse(out.contains("\\u30e6"), "日本語を \\uXXXX にしない");
        assertFalse(out.contains("\\u30E6"));
    }

    @Test
    @DisplayName("T-5: U+2028 / U+2029 は必ずエスケープする")
    void lineSeparatorsEscaped() {
        String out = printer.printTable(FixtureModels.escapeTable());
        assertFalse(out.indexOf((char) 0x2028) >= 0, "生の U+2028 が出力に混入してはならない");
        assertFalse(out.indexOf((char) 0x2029) >= 0, "生の U+2029 が出力に混入してはならない");
        assertTrue(out.contains("\\u2028"), "U+2028 がエスケープされること");
        assertTrue(out.contains("\\u2029"), "U+2029 がエスケープされること");
    }

    @Test
    @DisplayName("T-6: 予約語のキーはクォートされる")
    void reservedWordKeysQuoted() {
        String out = printer.printTable(FixtureModels.escapeTable());
        // meta.columns のキー（カラム名 default / class）はクォートが必要
        assertTrue(out.contains("\"default\": {"), "予約語キー default はクォートされること");
        assertTrue(out.contains("\"class\": {"), "予約語キー class はクォートされること");
        // 値としての "default" はカラム定義の name であり、常にクォートされている
        assertTrue(out.contains("{ name: \"default\","));

        String dict = printer.printDictionary(FixtureModels.dictionary());
        assertTrue(dict.contains("\"default\": { displayName: \"既定値\" },"));
        assertTrue(dict.contains("id: { displayName: \"ID\" },"), "識別子として妥当なキーは裸のまま");
    }

    @Test
    @DisplayName("改行は LF のみ、末尾に改行1つ、BOM なし")
    void lineEndings() {
        String out = printer.printTable(FixtureModels.usersTable());
        assertFalse(out.contains("\r"), "CR を含まない");
        assertTrue(out.endsWith("});\n"), "末尾は }); + 改行1つ");
        assertFalse(out.endsWith("\n\n"), "末尾の改行は1つだけ");
        assertFalse(out.startsWith("\uFEFF"), "BOM を付けない");
    }

    @Test
    @DisplayName("T-11: ロケールを変えても出力が同一（コードポイント順ソート）")
    void localeIndependence() {
        Locale original = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR")); // トルコ語の i 問題
            String tr = printer.printTable(FixtureModels.usersTable());
            String trIndex = printer.printIndex(FixtureModels.indexModel());
            Locale.setDefault(Locale.JAPAN);
            assertEquals(tr, printer.printTable(FixtureModels.usersTable()));
            assertEquals(trIndex, printer.printIndex(FixtureModels.indexModel()));
        } finally {
            Locale.setDefault(original);
        }
    }
}
