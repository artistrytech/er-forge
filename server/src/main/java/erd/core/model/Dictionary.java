package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/** data/dictionary.js（human-owned）。カラム物理名 → 論理名の横断辞書。 */
public record Dictionary(Map<String, String> columns, Map<String, JsonNode> unknown) {
    public static final Dictionary EMPTY = new Dictionary(Map.of(), Map.of());

    public Dictionary {
        columns = columns == null ? Map.of() : new LinkedHashMap<>(columns);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }
}
