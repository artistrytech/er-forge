package erd.core.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ファイル1枚に対応する。id は schema / meta の外にある（リネーム時のみ変わる）。
 *
 * <p>machine-owned と human-owned の分離を型で保証する:
 * 逆生成の適用は {@link #withSchema(TableSchema)} しか呼べない（meta を引き継ぐ）。
 * テーブル編集の保存は {@link #withSchema(TableSchema)}.{@link #withMeta(TableMeta)}（両方を置換）。
 */
public record Table(String id, TableSchema schema, TableMeta meta, Map<String, JsonNode> unknown) {
    public Table {
        meta = meta == null ? TableMeta.EMPTY : meta;
        unknown = unknown == null ? Map.of() : new LinkedHashMap<>(unknown);
    }

    public Table(String id, TableSchema schema, TableMeta meta) {
        this(id, schema, meta, Map.of());
    }

    /** 逆生成の適用。meta と unknown を引き継いだまま schema だけを差し替える。 */
    public Table withSchema(TableSchema newSchema) {
        return new Table(id, newSchema, meta, unknown);
    }

    /** テーブル編集の保存。 */
    public Table withMeta(TableMeta newMeta) {
        return new Table(id, schema, newMeta, unknown);
    }
}
