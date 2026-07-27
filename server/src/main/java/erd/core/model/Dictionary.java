package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * data/dictionary.js（human-owned）。カラム物理名 → 共通設定（論理名・タグ・色）の横断辞書。
 *
 * @see DictionaryColumn
 */
public record Dictionary(Map<String, DictionaryColumn> columns, Map<String, JsonNode> unknown) {
    public static final Dictionary EMPTY = new Dictionary(Map.of(), Map.of());

    public Dictionary {
        columns = columns == null ? Map.of() : new LinkedHashMap<>(columns);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    /** 共通の論理名。未設定（タグ・色だけのエントリを含む）なら null。 */
    public String displayNameOf(String column) {
        DictionaryColumn c = columns.get(column);
        if (c == null || c.displayName() == null || c.displayName().isEmpty()) return null;
        return c.displayName();
    }
}
