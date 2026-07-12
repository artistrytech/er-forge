package erd.core.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/** カラム定義（machine-owned）。 */
public record Column(
        String name,
        String type,
        LogicalType logicalType,
        boolean nullable,
        @JsonProperty("default") String defaultValue,
        boolean autoIncrement,
        boolean generated,
        String comment,
        Map<String, JsonNode> unknown
) {
    public Column {
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public Column(String name, String type, LogicalType logicalType, boolean nullable) {
        this(name, type, logicalType, nullable, null, false, false, null, Map.of());
    }
}
