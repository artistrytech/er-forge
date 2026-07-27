package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * カラム単位の論理名・タグ・色・注記（human-owned）。論理名は辞書より優先される。
 *
 * <p>{@code tags} は分類・検索のため、{@code color} は見た目のためのもので、両者は独立である
 * （タグから色を導出しない。{@link ColorToken}）。
 */
public record ColumnMeta(
        String displayName,
        List<String> tags,
        String color,
        String notes,
        Map<String, JsonNode> unknown
) {
    public ColumnMeta {
        tags = tags == null ? List.of() : List.copyOf(tags);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public ColumnMeta(String displayName, String notes) {
        this(displayName, List.of(), null, notes, Map.of());
    }

    public boolean isEmpty() {
        return (displayName == null || displayName.isEmpty())
                && tags.isEmpty()
                && (color == null || color.isEmpty())
                && (notes == null || notes.isEmpty())
                && unknown.isEmpty();
    }
}
