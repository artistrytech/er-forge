package erd.core.model;

import java.util.List;
import java.util.Set;

/**
 * テーブル / カラムに指定できる色トークン（P-13）。データファイルにはトークン名だけを書き、
 * 実際の配色はビューアのテーマが持つ。
 *
 * <p>任意の hex を許さないのは意図的である。(1) ライト / ダークの双方で成立させるため、
 * (2) 文字色とのコントラストを人の手で崩させないため、(3)「なんとなく違う灰色」の量産を
 * 防ぐため。{@code muted} はグレーアウト（廃止など）専用の淡色。
 *
 * <p>色は<b>タグとは独立</b>である。タグから色を導出することはしない（設計書 §5.7）。
 */
public final class ColorToken {

    /** ビューアのテーマが持つトークンと1対1に対応する。並びは UI の表示順。 */
    public static final List<String> ALL =
            List.of("gray", "red", "amber", "green", "blue", "purple", "muted");

    private static final Set<String> KNOWN = Set.copyOf(ALL);

    private ColorToken() {
    }

    public static boolean isKnown(String token) {
        return token != null && KNOWN.contains(token);
    }
}
