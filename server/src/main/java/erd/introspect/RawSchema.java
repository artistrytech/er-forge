package erd.introspect;

import erd.core.model.TableSchema;

import java.util.List;

/**
 * 内省結果のスナップショット（K-08〜K-13 詳細設計 §1）。
 *
 * <p>machine-owned な情報しか含まない（meta は既存ファイル側にしかない。INV-1）。
 * プレビュー発行後はこのスナップショットを {@code IntrospectSession} が保持し、
 * 適用まで DB へ再接続しない。
 */
public record RawSchema(
        String product,
        String version,
        String driver,
        String namespace,
        List<TableSchema> tables,
        List<String> warnings
) {
    public RawSchema {
        tables = List.copyOf(tables);
        warnings = warnings == null ? List.of() : List.copyOf(warnings);
    }

    /** テーブルID（{@code schema.table}）。ネームスペースが空の DB では table 名のみ。 */
    public static String idOf(TableSchema t) {
        return t.schema() == null || t.schema().isEmpty() ? t.name() : t.schema() + "." + t.name();
    }
}
