package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** DB から取得される情報。逆生成が上書きする（machine-owned）。 */
public record TableSchema(
        String name,
        String schema,
        String comment,
        List<Column> columns,
        List<String> primaryKey,
        List<UniqueConstraint> uniques,
        List<IndexDef> indexes,
        List<ForeignKey> foreignKeys,
        Map<String, JsonNode> dialect
) {
    public TableSchema {
        columns = List.copyOf(columns);
        primaryKey = primaryKey == null ? List.of() : List.copyOf(primaryKey);
        uniques = uniques == null ? List.of() : List.copyOf(uniques);
        indexes = indexes == null ? List.of() : List.copyOf(indexes);
        foreignKeys = foreignKeys == null ? List.of() : List.copyOf(foreignKeys);
        dialect = dialect == null ? Map.of() : new LinkedHashMap<>(dialect);
    }
}
