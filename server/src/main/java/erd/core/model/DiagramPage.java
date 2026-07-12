package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/** ER図ページ1件（ERD.diagram）。視覚情報のみを持ち、スキーマ情報とはテーブルID で結ばれる。 */
public record DiagramPage(
        String id,
        String title,
        int order,
        Map<String, NodeLayout> nodes,
        Map<String, EdgeLayout> edges,
        Map<String, JsonNode> unknown
) {
    public DiagramPage {
        nodes = nodes == null ? Map.of() : new LinkedHashMap<>(nodes);
        edges = edges == null ? Map.of() : new LinkedHashMap<>(edges);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public DiagramPage(String id, String title, int order,
                       Map<String, NodeLayout> nodes, Map<String, EdgeLayout> edges) {
        this(id, title, order, nodes, edges, Map.of());
    }
}
