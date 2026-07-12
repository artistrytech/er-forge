package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * カーディナリティの上書き（human-owned）。キーはエッジID の後半（&lt;種別&gt;:&lt;制約名&gt;）。
 * parent: "0..1" / "1..1"、child: "0..1" / "1..1" / "0..N" / "1..N"。
 * null のフィールドは「物理からの導出値のまま」を意味する（部分上書き）。
 */
public record RelationMeta(String parent, String child, String notes, Map<String, JsonNode> unknown) {
    public RelationMeta {
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public RelationMeta(String parent, String child, String notes) {
        this(parent, child, notes, Map.of());
    }
}
