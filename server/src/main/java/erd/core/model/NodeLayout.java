package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/** ER図ページ上のノード。w は幅の明示指定（null = 内容に合わせて自動）。 */
public record NodeLayout(Point pos, Integer w, Map<String, JsonNode> unknown) {
    public NodeLayout {
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public NodeLayout(Point pos) {
        this(pos, null, Map.of());
    }

    public NodeLayout(Point pos, Integer w) {
        this(pos, w, Map.of());
    }
}
