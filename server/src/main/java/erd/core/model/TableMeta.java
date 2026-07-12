package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 人が書く情報。逆生成は読まない・書かない（唯一の例外は論理名の初期値補完）。 */
public record TableMeta(
        String displayName,
        List<String> tags,
        String notes,
        Map<String, ColumnMeta> columns,
        List<LogicalUnique> logicalUniques,
        List<LogicalForeignKey> logicalForeignKeys,
        Map<String, RelationMeta> relations,
        Map<String, JsonNode> unknown
) {
    public static final TableMeta EMPTY =
            new TableMeta(null, List.of(), null, Map.of(), List.of(), List.of(), Map.of(), Map.of());

    public TableMeta {
        tags = tags == null ? List.of() : List.copyOf(tags);
        columns = columns == null ? Map.of() : new LinkedHashMap<>(columns);
        logicalUniques = logicalUniques == null ? List.of() : List.copyOf(logicalUniques);
        logicalForeignKeys = logicalForeignKeys == null ? List.of() : List.copyOf(logicalForeignKeys);
        relations = relations == null ? Map.of() : new LinkedHashMap<>(relations);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public boolean isEmpty() {
        return (displayName == null || displayName.isEmpty())
                && tags.isEmpty()
                && (notes == null || notes.isEmpty())
                && columns.isEmpty()
                && logicalUniques.isEmpty()
                && logicalForeignKeys.isEmpty()
                && relations.isEmpty()
                && unknown.isEmpty();
    }
}
