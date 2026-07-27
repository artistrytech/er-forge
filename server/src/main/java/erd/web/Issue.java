package erd.web;

import erd.core.model.ColorToken;
import erd.core.model.MetaRules;

import java.util.List;
import java.util.Map;

/**
 * フィールド単位のエラー / 警告（§7 の 422 レスポンス形式）。テーブル保存（O-08）と
 * 辞書保存（P-03）が同じ形で返す。
 *
 * <p>タグ・色の検証はこのクラスに置く。<b>テーブル個別（meta）と横断辞書の両方で
 * 同じ規則を掛けるため</b>で、片方だけに置くともう片方から壊れた値が入る。
 */
public record Issue(String path, String code, String message) {

    Map<String, String> toMap() {
        return Map.of("path", path, "code", code, "message", message);
    }

    /** 正規化済みタグ配列の検証（P-12）。件数の上限と1件ごとの規則（{@link MetaRules}）。 */
    static void validateTags(String path, List<String> tags, List<Issue> errors) {
        if (tags.size() > MetaRules.MAX_TAGS) {
            errors.add(new Issue(path, "TOO_MANY",
                    "at most " + MetaRules.MAX_TAGS + " tags are allowed (" + tags.size() + ")"));
        }
        for (int i = 0; i < tags.size(); i++) {
            String code = MetaRules.tagError(tags.get(i));
            if (code == null) continue;
            errors.add(new Issue(path + "[" + i + "]", code, switch (code) {
                case "TAG_WHITESPACE" -> "a tag must not contain whitespace: " + tags.get(i);
                case "TAG_SEPARATOR" -> "a tag must not contain , or 、: " + tags.get(i);
                default -> "a tag must be at most " + MetaRules.MAX_TAG_LENGTH + " characters: "
                        + tags.get(i);
            }));
        }
    }

    /** 色トークンの検証（P-13）。未知のトークンは拒否する（ビューアは描画できない）。 */
    static void validateColor(String path, String color, List<Issue> errors) {
        if (color == null || ColorToken.isKnown(color)) return;
        errors.add(new Issue(path, "UNKNOWN_COLOR",
                "unknown color: " + color + " (expected one of " + String.join(", ", ColorToken.ALL) + ")"));
    }
}
