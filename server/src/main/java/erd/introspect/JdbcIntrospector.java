package erd.introspect;

import com.fasterxml.jackson.databind.JsonNode;
import erd.core.model.Column;
import erd.core.model.ForeignKey;
import erd.core.model.IndexDef;
import erd.core.model.Ref;
import erd.core.model.TableSchema;
import erd.core.model.UniqueConstraint;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 層1: JDBC 標準メタデータによる内省（§7.1 / §7.3）。
 *
 * <p>DatabaseMetaData だけで完結するため、drivers/ に jar を置くだけで未知の DB にも対応できる。
 * 性能: {@code getColumns} はテーブルごとに呼ばず、ネームスペース全体を1回で取得して
 * メモリ上で分配する（§7.3）。{@code getIndexInfo} は API 仕様上テーブル単位のため個別に呼ぶ。
 */
public final class JdbcIntrospector implements Introspector {

    @Override
    public RawSchema introspect(Connection conn, IntrospectOptions opts) throws SQLException {
        DatabaseMetaData md = conn.getMetaData();
        List<String> warnings = new ArrayList<>(opts.warnings());
        boolean catalogMode = isCatalogMode(md);
        String ns = opts.namespace();
        String catalog = catalogMode ? ns : null;
        String schema = catalogMode ? null : ns;

        // 1. オブジェクト一覧（テーブルとビュー等。種別は原文のまま持つ。K-16）
        List<String> names = new ArrayList<>();
        Map<String, String> comments = new LinkedHashMap<>();
        Map<String, String> kinds = new LinkedHashMap<>();
        try (ResultSet rs = md.getTables(catalog, schema, "%", relationLikeTypes(md, warnings))) {
            while (rs.next()) {
                String name = rs.getString("TABLE_NAME");
                if (!opts.accepts(ns, name)) continue;
                names.add(name);
                comments.put(name, trimToNull(rs.getString("REMARKS")));
                kinds.put(name, normalizeKind(rs.getString("TABLE_TYPE")));
            }
        }
        names.sort(Comparator.naturalOrder());

        // 2. カラム（一括取得 → テーブル別に分配。§7.3）
        Map<String, List<Column>> columns = new LinkedHashMap<>();
        Map<String, Map<String, String>> columnComments = new LinkedHashMap<>();
        try (ResultSet rs = md.getColumns(catalog, schema, "%", "%")) {
            while (rs.next()) {
                String table = rs.getString("TABLE_NAME");
                if (!comments.containsKey(table)) continue;

                // 以降は JDBC の列番号昇順に読む。Oracle は REMARKS(12) / COLUMN_DEF(13) を LONG
                // （ストリーム）で返すため、IS_NULLABLE(18) などを先に読んでから戻ると
                // ORA-17027「ストリームはすでにクローズ済」で内省が丸ごと落ちる。
                String name = rs.getString("COLUMN_NAME");              // 4
                int dataType = rs.getInt("DATA_TYPE");                  // 5
                String typeName = rs.getString("TYPE_NAME");            // 6
                int columnSize = rs.getInt("COLUMN_SIZE");              // 7
                int decimalDigits = rs.getInt("DECIMAL_DIGITS");        // 9
                String comment = trimToNull(rs.getString("REMARKS"));   // 12
                String rawDefault = rs.getString("COLUMN_DEF");         // 13
                String isNullable = rs.getString("IS_NULLABLE");        // 18
                boolean autoIncrement =
                        "YES".equalsIgnoreCase(rs.getString("IS_AUTOINCREMENT"));   // 23
                boolean generated =
                        "YES".equalsIgnoreCase(rs.getString("IS_GENERATEDCOLUMN")); // 24

                TypeMapper.ColumnType t =
                        TypeMapper.map(typeName, dataType, columnSize, decimalDigits);
                boolean nullable;
                if ("NO".equalsIgnoreCase(isNullable)) {
                    nullable = false;
                } else if ("YES".equalsIgnoreCase(isNullable)) {
                    nullable = true;
                } else {
                    // 不明（""）は NULL 可として扱い、その旨を警告に出す（§2.3）
                    nullable = true;
                    warnings.add(table + "." + name + ": IS_NULLABLE is unknown; treating as nullable");
                }
                String def = defaultValue(rawDefault, autoIncrement);

                columns.computeIfAbsent(table, k -> new ArrayList<>()).add(new Column(
                        name, t.type(), t.logicalType(), nullable, def,
                        autoIncrement, generated, comment, t.dialect()));
                columnComments.computeIfAbsent(table, k -> new LinkedHashMap<>())
                        .put(name, comment);
            }
        }

        List<TableSchema> tables = new ArrayList<>();
        for (String name : names) {
            List<Column> cols = columns.get(name);
            if (cols == null) {
                warnings.add(name + ": Could not read columns. Check permissions.");
                continue;
            }
            // 制約系は種別で分岐しない。ビューでは空が返るのが普通だが、マテリアライズドビューでは
            // 実インデックスが取れる（PostgreSQL / Oracle で確認済み）。未知のドライバが例外を
            // 投げても内省全体は止めず、そのオブジェクトの制約だけを諦める（§7.1 の2層構成と同じ思想）。
            List<String> pk = List.of();
            List<UniqueConstraint> uniques = new ArrayList<>();
            List<IndexDef> indexes = new ArrayList<>();
            try {
                pk = primaryKey(md, catalog, schema, name);
                indexes(md, catalog, schema, name, pk, uniques, indexes);
            } catch (SQLException e) {
                uniques.clear();
                indexes.clear();
                warnings.add(name + ": Could not read key/index metadata (" + e.getMessage() + ")");
            }
            List<ForeignKey> fks;
            try {
                fks = foreignKeys(md, catalog, schema, name, catalogMode);
            } catch (SQLException e) {
                fks = List.of();
                warnings.add(name + ": Could not read foreign key metadata (" + e.getMessage() + ")");
            }
            tables.add(new TableSchema(name, ns, kinds.getOrDefault(name, TableSchema.TABLE),
                    comments.get(name), cols, pk, uniques, indexes, fks,
                    Map.<String, JsonNode>of()));
        }

        String driver = md.getDriverName() + " " + md.getDriverVersion();
        return new RawSchema(md.getDatabaseProductName(), md.getDatabaseProductVersion(),
                driver, ns, tables, warnings);
    }

    // ------------------------------------------------------------------ 種別（K-16）

    /** {@code getTableTypes()} が使えないドライバ向けのフォールバック（現行の挙動を下回らない）。 */
    private static final String[] FALLBACK_TYPES = { "TABLE", "VIEW" };

    /**
     * 取り込む種別の一覧（K-16 詳細設計 §4.1）。
     *
     * <p>{@code getTableTypes()} の戻り値を<b>DB を問わない1つのルール</b>で絞る。製品ごとの分岐は
     * 持たない。索引・シーケンス・型・同義語・システム領域はここで落ちる。
     * {@code types = null}（全種別）にしてはならない: PostgreSQL では {@code public} スキーマの
     * インデックスとシーケンスが、Oracle ではシノニムが、そのまま一覧に混入する。
     */
    private static String[] relationLikeTypes(DatabaseMetaData md, List<String> warnings) {
        List<String> types = new ArrayList<>();
        try (ResultSet rs = md.getTableTypes()) {
            while (rs.next()) {
                String type = rs.getString(1);
                if (isRelationLike(type)) types.add(type);
            }
        } catch (SQLException e) {
            warnings.add("Could not read table types (" + e.getMessage()
                    + "); falling back to TABLE / VIEW");
            return FALLBACK_TYPES;
        }
        return types.isEmpty() ? FALLBACK_TYPES : types.toArray(String[]::new);
    }

    /** 「名前に TABLE か VIEW を含み、SYSTEM を含まない」。これが唯一の判定規則である。 */
    static boolean isRelationLike(String tableType) {
        if (tableType == null) return false;
        String t = tableType.toUpperCase(java.util.Locale.ROOT);
        if (t.contains("SYSTEM")) return false;
        return t.contains("TABLE") || t.contains("VIEW");
    }

    /**
     * {@code TABLE_TYPE} の正規化。SQL 標準の別名である {@code BASE TABLE} だけを畳み、
     * それ以外は原文のまま保つ（{@code MATERIALIZED VIEW} → {@code VIEW} のような
     * 意味を落とす正規化はしない）。
     *
     * <p>H2 は要求側の {@code "TABLE"} を受け付けるのに {@code TABLE_TYPE} には
     * {@code "BASE TABLE"} を返す。ここで畳まないと、H2 では全テーブルが「特殊」に分類される。
     */
    static String normalizeKind(String tableType) {
        if (tableType == null) return TableSchema.TABLE;
        String t = tableType.trim();
        if (t.isEmpty()) return TableSchema.TABLE;
        return t.equalsIgnoreCase("BASE TABLE") ? TableSchema.TABLE : t;
    }

    // ------------------------------------------------------------ 各メタデータ

    private static List<String> primaryKey(DatabaseMetaData md, String catalog, String schema,
                                           String table) throws SQLException {
        TreeMap<Short, String> bySeq = new TreeMap<>();
        try (ResultSet rs = md.getPrimaryKeys(catalog, schema, table)) {
            while (rs.next()) {
                bySeq.put(rs.getShort("KEY_SEQ"), rs.getString("COLUMN_NAME"));
            }
        }
        return List.copyOf(bySeq.values());
    }

    /**
     * インデックス / ユニーク制約。JDBC 標準では両者を区別できないため（§7.4）、
     * ユニークなものは {@code uniques}、それ以外は {@code indexes} に振り分ける。
     * 主キーと同一カラム構成のユニークインデックス（PK の裏付けインデックス）は重複のため捨てる。
     */
    private static void indexes(DatabaseMetaData md, String catalog, String schema, String table,
                                List<String> pk, List<UniqueConstraint> uniques,
                                List<IndexDef> indexes) throws SQLException {
        Map<String, TreeMap<Short, String>> byName = new LinkedHashMap<>();
        Map<String, Boolean> unique = new LinkedHashMap<>();
        try (ResultSet rs = md.getIndexInfo(catalog, schema, table, false, true)) {
            while (rs.next()) {
                if (rs.getShort("TYPE") == DatabaseMetaData.tableIndexStatistic) continue;
                String name = rs.getString("INDEX_NAME");
                String column = rs.getString("COLUMN_NAME");
                if (name == null || column == null) continue;
                byName.computeIfAbsent(name, k -> new TreeMap<>())
                        .put(rs.getShort("ORDINAL_POSITION"), column);
                unique.put(name, !rs.getBoolean("NON_UNIQUE"));
            }
        }
        for (Map.Entry<String, TreeMap<Short, String>> e : byName.entrySet()) {
            List<String> cols = List.copyOf(e.getValue().values());
            boolean isUnique = Boolean.TRUE.equals(unique.get(e.getKey()));
            if (isUnique && cols.equals(pk)) continue;  // PK の裏付けインデックス
            if (isUnique) {
                uniques.add(new UniqueConstraint(e.getKey(), cols));
            } else {
                indexes.add(new IndexDef(e.getKey(), cols, false));
            }
        }
    }

    private static List<ForeignKey> foreignKeys(DatabaseMetaData md, String catalog, String schema,
                                                String table, boolean catalogMode) throws SQLException {
        record Part(short seq, String column, String refTable, String refColumn,
                    String onUpdate, String onDelete) {}
        Map<String, List<Part>> byName = new LinkedHashMap<>();
        try (ResultSet rs = md.getImportedKeys(catalog, schema, table)) {
            while (rs.next()) {
                String pkNs = catalogMode ? rs.getString("PKTABLE_CAT") : rs.getString("PKTABLE_SCHEM");
                String refTable = (pkNs == null || pkNs.isEmpty() ? "" : pkNs + ".")
                        + rs.getString("PKTABLE_NAME");
                String name = rs.getString("FK_NAME");
                if (name == null || name.isEmpty()) {
                    name = table + "_" + rs.getString("FKCOLUMN_NAME") + "_fkey";
                }
                byName.computeIfAbsent(name, k -> new ArrayList<>()).add(new Part(
                        rs.getShort("KEY_SEQ"), rs.getString("FKCOLUMN_NAME"),
                        refTable, rs.getString("PKCOLUMN_NAME"),
                        rule(rs.getShort("UPDATE_RULE")), rule(rs.getShort("DELETE_RULE"))));
            }
        }
        List<ForeignKey> fks = new ArrayList<>();
        for (Map.Entry<String, List<Part>> e : byName.entrySet()) {
            List<Part> parts = new ArrayList<>(e.getValue());
            parts.sort(Comparator.comparing(Part::seq));
            Part head = parts.get(0);
            fks.add(new ForeignKey(e.getKey(),
                    parts.stream().map(Part::column).toList(),
                    new Ref(head.refTable(), parts.stream().map(Part::refColumn).toList()),
                    head.onDelete(), head.onUpdate()));
        }
        return fks;
    }

    private static String rule(short rule) {
        return switch (rule) {
            case DatabaseMetaData.importedKeyCascade -> "cascade";
            case DatabaseMetaData.importedKeyRestrict -> "restrict";
            case DatabaseMetaData.importedKeySetNull -> "set null";
            case DatabaseMetaData.importedKeySetDefault -> "set default";
            default -> ForeignKey.DEFAULT_ACTION;
        };
    }

    // ------------------------------------------------------------ ネームスペース

    /** MySQL は catalog = データベース、PostgreSQL は schema（§7.4）。 */
    public static boolean isCatalogMode(DatabaseMetaData md) throws SQLException {
        try (ResultSet rs = md.getSchemas()) {
            if (rs.next()) return false;
        }
        return true;
    }

    /** 接続テスト（K-04）で提示するネームスペース一覧。システム領域は除く。 */
    public static List<String> namespaces(Connection conn) throws SQLException {
        DatabaseMetaData md = conn.getMetaData();
        List<String> out = new ArrayList<>();
        if (isCatalogMode(md)) {
            try (ResultSet rs = md.getCatalogs()) {
                while (rs.next()) {
                    String c = rs.getString("TABLE_CAT");
                    if (c != null && !isSystemNamespace(c)) out.add(c);
                }
            }
        } else {
            try (ResultSet rs = md.getSchemas()) {
                while (rs.next()) {
                    String s = rs.getString("TABLE_SCHEM");
                    if (s != null && !isSystemNamespace(s)) out.add(s);
                }
            }
        }
        out.sort(Comparator.naturalOrder());
        return out;
    }

    private static boolean isSystemNamespace(String ns) {
        String n = ns.toLowerCase(java.util.Locale.ROOT);
        return n.equals("information_schema")
                || n.startsWith("pg_")
                || n.equals("mysql")
                || n.equals("performance_schema")
                || n.equals("sys");
    }

    // ------------------------------------------------------------------ 正規化

    /**
     * COLUMN_DEF の正規化。自動採番列のシーケンス既定値（{@code nextval('users_id_seq')}）は
     * autoIncrement で表現済みであり、シーケンス名がテーブル名に依存して差分ノイズになるため落とす。
     */
    private static String defaultValue(String raw, boolean autoIncrement) {
        String def = trimToNull(raw);
        if (def == null) return null;
        if (autoIncrement && def.toLowerCase(java.util.Locale.ROOT).startsWith("nextval(")) return null;
        return erd.core.diff.Normalize.defaultValue(def);
    }

    private static String trimToNull(String s) {
        if (s == null) return null;
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }
}
