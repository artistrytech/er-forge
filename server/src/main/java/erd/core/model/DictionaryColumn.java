package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 横断辞書の1エントリ（human-owned）。<b>同名カラム全体に効く共通設定</b>で、
 * テーブル固有の情報は書かない（P INV-3）。
 *
 * <p>テーブル個別（{@link ColumnMeta}）との合わせ方は属性ごとに違う。
 * <ul>
 *   <li>{@code displayName}: 個別が<b>上書き</b>する</li>
 *   <li>{@code color}: 個別が<b>上書き</b>する</li>
 *   <li>{@code tags}: 個別と<b>合成</b>する。共通タグは個別からは取り消せない（P-12）</li>
 * </ul>
 * 合成規則の実体はビューア側（model/logicalName.ts）にあり、ここは値の入れ物である。
 */
public record DictionaryColumn(
        String displayName,
        List<String> tags,
        String color,
        Map<String, JsonNode> unknown
) {
    public DictionaryColumn {
        tags = tags == null ? List.of() : List.copyOf(tags);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public DictionaryColumn(String displayName) {
        this(displayName, List.of(), null, Map.of());
    }

    /** 全フィールドが空。論理名だけでなくタグ・色も無いときに限りエントリを落とす。 */
    public boolean isEmpty() {
        return (displayName == null || displayName.isEmpty())
                && tags.isEmpty()
                && (color == null || color.isEmpty())
                && unknown.isEmpty();
    }
}
