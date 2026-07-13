package erd.core.diff;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** テーブル無視リストのマッチング（K-15 / §2.4）。 */
class PatternListTest {

    @Test
    @DisplayName("完全一致・glob・正規表現の3記法")
    void threeNotations() {
        PatternList list = PatternList.of(List.of(
                "public.flyway_schema_history",
                "public.tmp_*",
                "public.log_?",
                "/^staging\\..*_bak$/"));

        assertTrue(list.matches("public.flyway_schema_history"));
        assertFalse(list.matches("public.flyway_schema_history2"));

        assertTrue(list.matches("public.tmp_20260701"));
        assertTrue(list.matches("public.tmp_"));
        assertFalse(list.matches("public.tmpx"));

        assertTrue(list.matches("public.log_1"));
        assertFalse(list.matches("public.log_12"));

        assertTrue(list.matches("staging.users_bak"));
        assertFalse(list.matches("staging.users"));
        assertFalse(list.matches("public.users"));
    }

    @Test
    @DisplayName("マッチしたパターンの原文を返す（プレビューの「無視 (N)」に併記する）")
    void reportsMatchedPattern() {
        PatternList list = PatternList.of(List.of("public.tmp_*"));
        assertEquals("public.tmp_*", list.matchedBy("public.tmp_a"));
    }

    @Test
    @DisplayName("T-11b: 不正な正規表現は警告して無視する（全マッチする暴走をしない）")
    void invalidRegexIsIgnored() {
        PatternList list = PatternList.of(List.of("/^(unclosed/", "public.users"));

        assertFalse(list.matches("anything.at.all"));
        assertTrue(list.matches("public.users"));
        assertEquals(1, list.warnings().size());
    }

    @Test
    @DisplayName("glob のメタ文字以外は正規表現として解釈しない（. がワイルドカードにならない）")
    void dotIsLiteral() {
        PatternList list = PatternList.of(List.of("public.tmp_*"));
        assertFalse(list.matches("publicXtmp_1"));
    }
}
