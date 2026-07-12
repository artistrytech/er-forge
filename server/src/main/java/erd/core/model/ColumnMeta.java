package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/** カラム単位の論理名・注記（human-owned）。辞書より優先される。 */
public record ColumnMeta(String displayName, String notes, Map<String, JsonNode> unknown) {
    public ColumnMeta {
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public ColumnMeta(String displayName, String notes) {
        this(displayName, notes, Map.of());
    }

    public boolean isEmpty() {
        return (displayName == null || displayName.isEmpty())
                && (notes == null || notes.isEmpty())
                && unknown.isEmpty();
    }
}
