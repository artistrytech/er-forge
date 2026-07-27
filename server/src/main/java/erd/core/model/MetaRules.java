package erd.core.model;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * タグ・色の正規化と検証の規則（P-12 / P-13）。ビューアにも同じ規則の実装がある
 * （viewer: model/metaRules.ts）。<b>サーバー側にも置くのは、手で編集したファイルや
 * 古いクライアントからの書き込みで壊れた値が入るのを防ぐため</b>。
 *
 * <p>正規化（黙って直すもの）と検証（422 で拒否するもの）を分けている。前後の空白や
 * 重複は書き手の意図が明らかなので直し、区切り文字の混入や長すぎる値は
 * 「入力の取り違え」の可能性が高いので拒否する。
 */
public final class MetaRules {

    /** 1タグの最大長（文字数。コードポイント数で数える）。 */
    public static final int MAX_TAG_LENGTH = 32;

    /** 1テーブル / 1カラムに付けられるタグの最大数。 */
    public static final int MAX_TAGS = 20;

    private MetaRules() {
    }

    /**
     * タグ配列の正規化: NFC → 前後空白の除去 → 空要素の除去 → 重複除去（大小無視・先勝ち）。
     * 並びは入力順を保つ（タグの順序に意味は無いが、人の書いた順を勝手に変えない）。
     */
    public static List<String> normalizeTags(List<String> raw) {
        if (raw == null || raw.isEmpty()) return List.of();
        List<String> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (String tag : raw) {
            if (tag == null) continue;
            String t = Normalizer.normalize(tag, Normalizer.Form.NFC).trim();
            if (t.isEmpty()) continue;
            if (seen.add(t.toLowerCase(Locale.ROOT))) out.add(t);
        }
        return List.copyOf(out);
    }

    /** 色の正規化: 前後空白の除去。空文字は「未設定」= null に倒す。 */
    public static String normalizeColor(String raw) {
        if (raw == null) return null;
        String c = raw.trim();
        return c.isEmpty() ? null : c;
    }

    /**
     * 正規化済みタグ1件の検証。問題なければ null、あればエラーコードを返す。
     *
     * <p>空白を禁じるのは、タグ入力 UI が空白でタグを確定するため（P-12）。
     * 区切り文字（{@code ,} {@code 、}）を禁じるのは、1件のつもりで複数件を書いた
     * 入力を黙って1件のタグにしないため。
     */
    public static String tagError(String tag) {
        if (tag.codePoints().anyMatch(Character::isWhitespace)) return "TAG_WHITESPACE";
        if (tag.indexOf(',') >= 0 || tag.indexOf('、') >= 0) return "TAG_SEPARATOR";
        if (tag.codePointCount(0, tag.length()) > MAX_TAG_LENGTH) return "TAG_TOO_LONG";
        return null;
    }
}
