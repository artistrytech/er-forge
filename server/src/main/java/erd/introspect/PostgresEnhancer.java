package erd.introspect;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 層2: PostgreSQL（§7.1 / §7.4）。
 *
 * <p>JDBC 標準メタデータでは取得できない情報を {@code pg_catalog} から補う。
 * <ul>
 *   <li>CHECK 制約（標準に API が存在しない）</li>
 *   <li>ENUM 型の値一覧（{@code TYPE_NAME} は型名しか返さない）</li>
 *   <li>部分インデックス・式インデックス（{@code getIndexInfo} では表現できない）</li>
 * </ul>
 *
 * <p>いずれも表示専用の情報であり、差分検出では {@code dialect} 全体を1項目として比較する。
 */
public final class PostgresEnhancer implements DialectEnhancer {

    @Override
    public boolean supports(DatabaseMetaData md) throws SQLException {
        String product = md.getDatabaseProductName();
        return product != null && product.toLowerCase(Locale.ROOT).contains("postgresql");
    }

    @Override
    public RawSchema enhance(Connection conn, RawSchema schema) throws SQLException {
        Map<String, Dialects.Builder> byTable = new LinkedHashMap<>();
        String ns = schema.namespace();
        checks(conn, ns, byTable);
        enums(conn, ns, byTable);
        indexes(conn, ns, byTable);
        definitions(conn, ns, byTable);
        return Dialects.merge(schema, byTable);
    }

    private static Dialects.Builder builder(Map<String, Dialects.Builder> byTable, String table) {
        return byTable.computeIfAbsent(table, k -> new Dialects.Builder());
    }

    private static final String CHECKS_SQL = """
            SELECT rel.relname AS tbl, con.conname AS name, pg_get_constraintdef(con.oid) AS expr
              FROM pg_constraint con
              JOIN pg_class rel ON rel.oid = con.conrelid
              JOIN pg_namespace ns ON ns.oid = rel.relnamespace
             WHERE con.contype = 'c' AND ns.nspname = ?
             ORDER BY rel.relname, con.conname
            """;

    private void checks(Connection conn, String ns, Map<String, Dialects.Builder> byTable)
            throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(CHECKS_SQL)) {
            ps.setString(1, ns);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    builder(byTable, rs.getString("tbl"))
                            .addCheck(rs.getString("name"), rs.getString("expr"));
                }
            }
        }
    }

    private static final String ENUMS_SQL = """
            SELECT c.relname AS tbl, a.attname AS col, e.enumlabel AS val
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_type t ON t.oid = a.atttypid
              JOIN pg_enum e ON e.enumtypid = t.oid
             WHERE n.nspname = ? AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY c.relname, a.attname, e.enumsortorder
            """;

    private void enums(Connection conn, String ns, Map<String, Dialects.Builder> byTable)
            throws SQLException {
        // (テーブル, カラム) ごとに値を集約する。enumsortorder 順が DB 上の宣言順
        Map<String, Map<String, List<String>>> values = new LinkedHashMap<>();
        try (PreparedStatement ps = conn.prepareStatement(ENUMS_SQL)) {
            ps.setString(1, ns);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    values.computeIfAbsent(rs.getString("tbl"), k -> new LinkedHashMap<>())
                            .computeIfAbsent(rs.getString("col"), k -> new ArrayList<>())
                            .add(rs.getString("val"));
                }
            }
        }
        values.forEach((table, columns) ->
                columns.forEach((column, vals) -> builder(byTable, table).addEnum(column, vals)));
    }

    private static final String INDEXES_SQL = """
            SELECT c.relname AS tbl, i.relname AS name,
                   pg_get_indexdef(x.indexrelid) AS def,
                   pg_get_expr(x.indpred, x.indrelid) AS predicate
              FROM pg_index x
              JOIN pg_class c ON c.oid = x.indrelid
              JOIN pg_class i ON i.oid = x.indexrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = ? AND (x.indpred IS NOT NULL OR x.indexprs IS NOT NULL)
             ORDER BY c.relname, i.relname
            """;

    /** 部分インデックス（WHERE 付き）と式インデックスのみ。通常のインデックスは層1が持っている。 */
    private void indexes(Connection conn, String ns, Map<String, Dialects.Builder> byTable)
            throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(INDEXES_SQL)) {
            ps.setString(1, ns);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    builder(byTable, rs.getString("tbl")).addIndex(
                            rs.getString("name"), rs.getString("def"), rs.getString("predicate"));
                }
            }
        }
    }

    private static final String DEFINITIONS_SQL = """
            SELECT c.relname AS tbl, pg_get_viewdef(c.oid, true) AS def
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = ? AND c.relkind IN ('v', 'm')
             ORDER BY c.relname
            """;

    /**
     * ビュー / マテリアライズドビューの定義 SQL（K-18）。
     *
     * <p>{@code pg_get_viewdef(oid, true)} は整形済み（複数行・インデント付き）で返し、同じ定義
     * からは常に同じ文字列が出る。整形しない版を使うと1行に潰れ、Git 差分が読めなくなる。
     */
    private void definitions(Connection conn, String ns, Map<String, Dialects.Builder> byTable)
            throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(DEFINITIONS_SQL)) {
            ps.setString(1, ns);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    builder(byTable, rs.getString("tbl")).setDefinition(rs.getString("def"));
                }
            }
        }
    }
}
