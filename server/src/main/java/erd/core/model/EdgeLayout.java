package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** ER図ページ上のエッジ。キーは <テーブルID>#<種別>:<制約名>。 */
public record EdgeLayout(List<Point> waypoints, Map<String, JsonNode> unknown) {
    public EdgeLayout {
        waypoints = waypoints == null ? List.of() : List.copyOf(waypoints);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public EdgeLayout(List<Point> waypoints) {
        this(waypoints, Map.of());
    }
}
