package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * data/manifest.js。ファイル一覧とデータ形式バージョン。
 *
 * <p><b>生成時刻（{@code generatedAt}）と接続元 DB（{@code source}）は持たない。</b>
 * どちらもファイルの中身と無関係に書き換わり、Git 管理ではノイズにしかならない
 * （ヘッダコメントを入れない理由と同じ。Phase0 詳細設計 §2.1）。
 * 読み込み時は既存ファイルとの互換のために受け付けて捨てる。
 */
public record Manifest(
        int schemaVersion,
        String config,
        String dictionary,
        Map<String, String> tables,      // テーブルID → 相対パス
        List<DiagramRef> diagrams,
        Map<String, JsonNode> unknown
) {
    public record DiagramRef(String id, String file, String title, int order) {}

    public Manifest {
        tables = tables == null ? Map.of() : new LinkedHashMap<>(tables);
        diagrams = diagrams == null ? List.of() : List.copyOf(diagrams);
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public Manifest withSchemaVersion(int v) {
        return new Manifest(v, config, dictionary, tables, diagrams, unknown);
    }
}
