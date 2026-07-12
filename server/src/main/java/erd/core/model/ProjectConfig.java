package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * data/config.js（human-owned）。
 * ignoreTables は人が書いた順を維持する（ソートしない）。
 */
public record ProjectConfig(List<String> ignoreTables, Map<String, JsonNode> unknown) {
    public static final ProjectConfig EMPTY = new ProjectConfig(List.of(), Map.of());

    public ProjectConfig {
        ignoreTables = ignoreTables == null ? List.of() : List.copyOf(ignoreTables);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }
}
