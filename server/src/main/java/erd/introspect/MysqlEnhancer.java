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
 * 層2: MySQL / MariaDB（§7.1 / §7.4）。
 *
 * <p>{@code information_schema} から CHECK 制約と ENUM / SET の値一覧を補う。
 * {@code unsigned}（{@code TYPE_NAME} が {@code "INT UNSIGNED"} を返す）は層1の
 * {@link TypeMapper} が処理済みであり、ここでは扱わない。
 *
 * <p>CHECK 制約は MySQL 8.0.16 未満には存在しない（{@code information_schema.CHECK_CONSTRAINTS}
 * 自体が無い）。その場合は SQL が失敗するが、<b>Enhancer の失敗は内省を止めない</b>
 * （{@link Dialects#enhance} が警告に落とす）ため、CHECK を先に取っても他の情報が失われるように
 * ならないよう、クエリごとに例外を握って続行する。
 */
public final class MysqlEnhancer implements DialectEnhancer {

    @Override
    public boolean supports(DatabaseMetaData md) throws SQLException {
        String product = md.getDatabaseProductName();
        if (product == null) return false;
        String p = product.toLowerCase(Locale.ROOT);
        return p.contains("mysql") || p.contains("mariadb");
    }

    @Override
    public RawSchema enhance(Connection conn, RawSchema schema) throws SQLException {
        Map<String, Dialects.Builder> byTable = new LinkedHashMap<>();
        String ns = schema.namespace();
        List<String> warnings = new ArrayList<>(schema.warnings());
        try {
            checks(conn, ns, byTable);
        } catch (SQLException e) {
            // MySQL 8.0.16 未満 / MariaDB 10.2 未満。CHECK 制約が取れないだけで内省は続行する
            warnings.add("CHECK 制約を取得できませんでした（この DB バージョンでは未対応の可能性があります）");
        }
        enums(conn, ns, byTable);
        RawSchema merged = Dialects.merge(schema, byTable);
        return new RawSchema(merged.product(), merged.version(), merged.driver(),
                merged.namespace(), merged.tables(), warnings);
    }

    private static Dialects.Builder builder(Map<String, Dialects.Builder> byTable, String table) {
        return byTable.computeIfAbsent(table, k -> new Dialects.Builder());
    }

    private static final String CHECKS_SQL = """
            SELECT tc.TABLE_NAME AS tbl, cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS expr
              FROM information_schema.CHECK_CONSTRAINTS cc
              JOIN information_schema.TABLE_CONSTRAINTS tc
                ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
               AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
             WHERE tc.TABLE_SCHEMA = ?
             ORDER BY tc.TABLE_NAME, cc.CONSTRAINT_NAME
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
            SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, COLUMN_TYPE AS coltype
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('enum', 'set')
             ORDER BY TABLE_NAME, COLUMN_NAME
            """;

    private void enums(Connection conn, String ns, Map<String, Dialects.Builder> byTable)
            throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(ENUMS_SQL)) {
            ps.setString(1, ns);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    List<String> values = parseEnumValues(rs.getString("coltype"));
                    if (!values.isEmpty()) {
                        builder(byTable, rs.getString("tbl")).addEnum(rs.getString("col"), values);
                    }
                }
            }
        }
    }

    /**
     * {@code COLUMN_TYPE} は {@code enum('active','banned')} の形で返る。
     * 値の中の {@code '} は {@code ''} でエスケープされている。
     */
    static List<String> parseEnumValues(String columnType) {
        List<String> out = new ArrayList<>();
        if (columnType == null) return out;
        int open = columnType.indexOf('(');
        int close = columnType.lastIndexOf(')');
        if (open < 0 || close <= open) return out;

        String body = columnType.substring(open + 1, close);
        StringBuilder current = new StringBuilder();
        boolean inQuote = false;
        for (int i = 0; i < body.length(); i++) {
            char c = body.charAt(i);
            if (!inQuote) {
                if (c == '\'') inQuote = true;
                continue;
            }
            if (c == '\'') {
                if (i + 1 < body.length() && body.charAt(i + 1) == '\'') {
                    current.append('\'');  // '' = リテラルの '
                    i++;
                } else {
                    inQuote = false;
                    out.add(current.toString());
                    current.setLength(0);
                }
                continue;
            }
            current.append(c);
        }
        return out;
    }
}
