package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** data/manifest.js。ファイル一覧とデータ形式バージョン。 */
public record Manifest(
        int schemaVersion,
        String generatedAt,
        Source source,
        String config,
        String dictionary,
        Map<String, String> tables,      // テーブルID → 相対パス
        List<DiagramRef> diagrams,
        Map<String, JsonNode> unknown
) {
    public record Source(String product, String version) {}

    public record DiagramRef(String id, String file, String title, int order) {}

    public Manifest {
        tables = tables == null ? Map.of() : new LinkedHashMap<>(tables);
        diagrams = diagrams == null ? List.of() : List.copyOf(diagrams);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public Manifest withSchemaVersion(int v) {
        return new Manifest(v, generatedAt, source, config, dictionary, tables, diagrams, unknown);
    }
}
