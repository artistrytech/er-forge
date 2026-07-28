package erd.core.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * DB から取得される情報。逆生成が上書きする（machine-owned）。
 *
 * <p>{@code kind} は DB が返した {@code TABLE_TYPE} の原文（{@code VIEW} /
 * {@code MATERIALIZED VIEW} / {@code FOREIGN TABLE} …）である。製品ごとの正規化はしない（K-16）。
 * 既定は {@link #TABLE} で、この値のときはファイルに出力しない（既存データとの差分を出さないため）。
 *
 * <p>{@code definition} はビュー等の定義 SQL を<b>行ごとに分けた</b>もの（K-18）。1本の長い文字列に
 * すると「1つの変更 = 1行の差分」（INV-5）が壊れるため、必ず行の配列で持つ。標準メタデータでは
 * 取得できないため、埋めるのは層2（{@link erd.introspect.DialectEnhancer}）である。
 */
public record TableSchema(
        String name,
        String schema,
        String kind,
        String comment,
        List<Column> columns,
        List<String> primaryKey,
        List<UniqueConstraint> uniques,
        List<IndexDef> indexes,
        List<ForeignKey> foreignKeys,
        List<String> definition,
        Map<String, JsonNode> dialect
) {
    /** 通常のテーブル。{@code kind} 欠落はこれとみなし、この値は出力しない。 */
    public static final String TABLE = "TABLE";

    public TableSchema {
        kind = kind == null || kind.isBlank() ? TABLE : kind;
        columns = List.copyOf(columns);
        primaryKey = primaryKey == null ? List.of() : List.copyOf(primaryKey);
        uniques = uniques == null ? List.of() : List.copyOf(uniques);
        indexes = indexes == null ? List.of() : List.copyOf(indexes);
        foreignKeys = foreignKeys == null ? List.of() : List.copyOf(foreignKeys);
        definition = definition == null ? List.of() : List.copyOf(definition);
        dialect = dialect == null ? Map.of() : new LinkedHashMap<>(dialect);
    }

    /** 定義 SQL を持たない呼び出し（通常テーブル、および層2を通す前の層1の結果）。 */
    public TableSchema(String name, String schema, String kind, String comment, List<Column> columns,
                       List<String> primaryKey, List<UniqueConstraint> uniques,
                       List<IndexDef> indexes, List<ForeignKey> foreignKeys,
                       Map<String, JsonNode> dialect) {
        this(name, schema, kind, comment, columns, primaryKey, uniques, indexes, foreignKeys,
                List.of(), dialect);
    }

    /**
     * 通常のテーブル向け（{@code kind} も {@code definition} も省略する呼び出し）。
     *
     * <p>{@code kind} はレコード成分の途中に入るため、これが無いと既存の呼び出しが全滅する。
     * 「ビューかどうか」を意識しない箇所は、この形のまま書ける。
     */
    public TableSchema(String name, String schema, String comment, List<Column> columns,
                       List<String> primaryKey, List<UniqueConstraint> uniques,
                       List<IndexDef> indexes, List<ForeignKey> foreignKeys,
                       Map<String, JsonNode> dialect) {
        this(name, schema, TABLE, comment, columns, primaryKey, uniques, indexes, foreignKeys,
                List.of(), dialect);
    }

    /**
     * 通常のテーブルか。表記揺れに備えて大小を無視する。
     *
     * <p>{@code @JsonIgnore} が要る: Jackson は {@code isXxx()} を bean のプロパティとみなすため、
     * これが無いとモデルの JSON 出力に {@code "table": true} という派生値が混入する。
     */
    @JsonIgnore
    public boolean isTable() {
        return TABLE.equalsIgnoreCase(kind);
    }

    /** {@code kind} だけを差し替える（差分の部分適用で使う）。 */
    public TableSchema withKind(String newKind) {
        return new TableSchema(name, schema, newKind, comment, columns, primaryKey, uniques,
                indexes, foreignKeys, definition, dialect);
    }

    /** {@code definition} だけを差し替える（層2が埋める / 差分の部分適用で使う）。 */
    public TableSchema withDefinition(List<String> newDefinition) {
        return new TableSchema(name, schema, kind, comment, columns, primaryKey, uniques,
                indexes, foreignKeys, newDefinition, dialect);
    }
}
