package erd.introspect;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * ビュー対応の可否を判断するための調査用プローブ（検証記録）。
 *
 * <p>アサーションを持たず、実測値を書き出すだけである。「{@code getTables} の types に何を渡すか」
 * という判断の根拠を、ドライバのバージョンを上げたときに取り直せるようにするために残している。
 * DB が起動していない環境では該当 DB を SKIPPED として飛ばすため、常時実行しても壊れない。
 *
 * <p>各 DB について次を実測する:
 * <ol>
 *   <li>{@code getTableTypes()} が返す種別名</li>
 *   <li>{@code getTables(types=null)} の種別別内訳（= 全種別を取ると何が混ざるか）</li>
 *   <li>現行の {@code types={"TABLE"}} で取れる件数</li>
 *   <li>提案ルール（名前に TABLE か VIEW を含み SYSTEM を含まない）で取れる件数</li>
 *   <li>ビューに対する getColumns / getPrimaryKeys / getIndexInfo / getImportedKeys の挙動</li>
 * </ol>
 *
 * <p>結果は server/build/probe/table-types.txt に書き出す。
 */
class TableTypeProbeTest {

    private static final StringBuilder OUT = new StringBuilder();

    private static void p(String s) {
        OUT.append(s).append('\n');
        System.out.println(s);
    }

    @Test
    void probe() throws Exception {
        probeH2();
        probeSqlite();
        probePostgres();
        probeSqlServer();
        probeOracle();

        Path dir = Path.of("build", "probe");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("table-types.txt"), OUT.toString());
        System.out.println("\n[written] " + dir.resolve("table-types.txt").toAbsolutePath());
    }

    // ------------------------------------------------------------------ 各 DB

    private void probeH2() {
        try (Connection conn = DriverManager.getConnection("jdbc:h2:mem:probe;DB_CLOSE_DELAY=-1")) {
            exec(conn,
                    "CREATE TABLE t_users (id INT PRIMARY KEY, email VARCHAR(200) NOT NULL)",
                    "CREATE TABLE t_orders (id INT PRIMARY KEY, user_id INT NOT NULL, "
                            + "CONSTRAINT fk_o_u FOREIGN KEY (user_id) REFERENCES t_users(id))",
                    "CREATE INDEX ix_orders_user ON t_orders(user_id)",
                    "CREATE SEQUENCE seq_probe",
                    "CREATE VIEW v_user_orders AS SELECT u.id, u.email, o.id AS order_id "
                            + "FROM t_users u JOIN t_orders o ON o.user_id = u.id");
            report(conn, "H2", "PUBLIC", List.of("V_USER_ORDERS", "v_user_orders"));
        } catch (Exception e) {
            p("=== H2: FAILED (" + e + ") ===\n");
        }
    }

    private void probeSqlite() {
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite::memory:")) {
            exec(conn,
                    "CREATE TABLE t_users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL)",
                    "CREATE TABLE t_orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL "
                            + "REFERENCES t_users(id))",
                    "CREATE INDEX ix_orders_user ON t_orders(user_id)",
                    "CREATE VIEW v_user_orders AS SELECT u.id, u.email, o.id AS order_id "
                            + "FROM t_users u JOIN t_orders o ON o.user_id = u.id");
            String ns = JdbcIntrospector.namespaces(conn).stream().findFirst().orElse("");
            report(conn, "SQLite", ns, List.of("v_user_orders"));
        } catch (Exception e) {
            p("=== SQLite: FAILED (" + e + ") ===\n");
        }
    }

    private void probePostgres() {
        Drivers.scan(Path.of("..", "dev", "drivers"));
        Connection conn = DbTestSupport.tryOpen(
                "jdbc:postgresql://localhost:5442/erd_sample", "erd", "erd", null);
        if (conn == null) {
            p("=== PostgreSQL: SKIPPED (not running) ===\n");
            return;
        }
        try (conn) {
            // 調査用オブジェクト（ビュー / マテビュー / パーティションテーブル）
            execIgnoring(conn,
                    "DROP VIEW IF EXISTS probe_v_users CASCADE",
                    "DROP MATERIALIZED VIEW IF EXISTS probe_mv_users CASCADE",
                    "DROP TABLE IF EXISTS probe_part CASCADE");
            exec(conn,
                    "CREATE VIEW probe_v_users AS SELECT id, email FROM users",
                    "CREATE MATERIALIZED VIEW probe_mv_users AS SELECT id, email FROM users",
                    "CREATE UNIQUE INDEX probe_mv_users_id ON probe_mv_users(id)",
                    "CREATE TABLE probe_part (id int NOT NULL, created_at date NOT NULL) "
                            + "PARTITION BY RANGE (created_at)",
                    "CREATE TABLE probe_part_2024 PARTITION OF probe_part "
                            + "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
                    "COMMENT ON VIEW probe_v_users IS 'プローブ用ビュー'");
            report(conn, "PostgreSQL", "public",
                    List.of("probe_v_users", "probe_mv_users"));
            execIgnoring(conn,
                    "DROP VIEW IF EXISTS probe_v_users CASCADE",
                    "DROP MATERIALIZED VIEW IF EXISTS probe_mv_users CASCADE",
                    "DROP TABLE IF EXISTS probe_part CASCADE");
        } catch (Exception e) {
            p("=== PostgreSQL: FAILED (" + e + ") ===\n");
        }
    }

    private void probeSqlServer() {
        Connection conn = DbTestSupport.tryOpen(
                "jdbc:sqlserver://localhost:1433;databaseName=erd_sample;encrypt=false;"
                        + "trustServerCertificate=true", "sa", "Erd_password1", null);
        if (conn == null) {
            p("=== SQL Server: SKIPPED (not running) ===\n");
            return;
        }
        try (conn) {
            execIgnoring(conn, "DROP VIEW probe_v_users", "DROP TABLE probe_users");
            exec(conn,
                    "CREATE TABLE probe_users (id int PRIMARY KEY, email nvarchar(255) NOT NULL)",
                    "CREATE VIEW probe_v_users AS SELECT id, email FROM probe_users");
            report(conn, "SQL Server", "dbo", List.of("probe_v_users"));
            execIgnoring(conn, "DROP VIEW probe_v_users", "DROP TABLE probe_users");
        } catch (Exception e) {
            p("=== SQL Server: FAILED (" + e + ") ===\n");
        }
    }

    private void probeOracle() {
        java.util.Properties props = new java.util.Properties();
        props.put("oracle.jdbc.remarksReporting", "true");   // コメントを REMARKS に載せる
        Connection conn = DbTestSupport.tryOpen(
                "jdbc:oracle:thin:@localhost:1521/FREEPDB1", "ERD", "erd", props);
        if (conn == null) {
            p("=== Oracle: SKIPPED (not running) ===\n");
            return;
        }
        try (conn) {
            execIgnoring(conn,
                    "DROP VIEW probe_v_users",
                    "DROP MATERIALIZED VIEW probe_mv_users",
                    "DROP SYNONYM probe_syn_users",
                    "DROP TABLE probe_users CASCADE CONSTRAINTS");
            exec(conn,
                    "CREATE TABLE probe_users (id NUMBER PRIMARY KEY, "
                            + "email VARCHAR2(255) NOT NULL)",
                    "CREATE VIEW probe_v_users AS SELECT id, email FROM probe_users",
                    "COMMENT ON TABLE probe_v_users IS 'プローブ用ビュー'");
            execIgnoring(conn,
                    "CREATE MATERIALIZED VIEW probe_mv_users AS SELECT id, email FROM probe_users",
                    "CREATE SYNONYM probe_syn_users FOR probe_users");
            report(conn, "Oracle", "ERD",
                    List.of("PROBE_V_USERS", "PROBE_MV_USERS"));
            execIgnoring(conn,
                    "DROP VIEW probe_v_users",
                    "DROP MATERIALIZED VIEW probe_mv_users",
                    "DROP SYNONYM probe_syn_users",
                    "DROP TABLE probe_users CASCADE CONSTRAINTS");
        } catch (Exception e) {
            p("=== Oracle: FAILED (" + e + ") ===\n");
        }
    }

    // ------------------------------------------------------------------ 共通

    private void report(Connection conn, String label, String ns, List<String> viewNames)
            throws SQLException {
        DatabaseMetaData md = conn.getMetaData();
        boolean catalogMode = JdbcIntrospector.isCatalogMode(md);
        String catalog = catalogMode ? ns : null;
        String schema = catalogMode ? null : ns;

        p("================================================================");
        p("=== " + label + " ===");
        p("product : " + md.getDatabaseProductName() + " " + md.getDatabaseProductVersion());
        p("driver  : " + md.getDriverName() + " " + md.getDriverVersion());
        p("namespace: " + ns + "  (catalogMode=" + catalogMode + ")");

        // --- 1. getTableTypes() ---
        List<String> types = new ArrayList<>();
        try (ResultSet rs = md.getTableTypes()) {
            while (rs.next()) {
                types.add(rs.getString(1));
            }
        }
        p("\n[1] getTableTypes() = " + types);

        // --- 2. getTables(types=null) の内訳 ---
        Map<String, List<String>> byType = new TreeMap<>();
        try (ResultSet rs = md.getTables(catalog, schema, "%", null)) {
            while (rs.next()) {
                byType.computeIfAbsent(String.valueOf(rs.getString("TABLE_TYPE")),
                        k -> new ArrayList<>()).add(rs.getString("TABLE_NAME"));
            }
        }
        p("\n[2] getTables(types=null) in ns=" + ns + " の種別別内訳");
        int total = 0;
        for (Map.Entry<String, List<String>> e : byType.entrySet()) {
            List<String> names = e.getValue();
            total += names.size();
            p(String.format("    %-22s %4d  %s", e.getKey(), names.size(), sample(names)));
        }
        p("    " + String.format("%-22s %4d", "(合計)", total));

        // --- 3. 現行（types={"TABLE"}）---
        p("\n[3] 現行 types={\"TABLE\"} の件数 = " + count(md, catalog, schema, new String[] { "TABLE" }));

        // --- 4. 提案ルール ---
        List<String> accepted = types.stream().filter(TableTypeProbeTest::relationLike).toList();
        p("\n[4] 提案ルール（名前に TABLE|VIEW を含み SYSTEM を含まない）");
        p("    採用種別 = " + accepted);
        p("    件数     = " + count(md, catalog, schema, accepted.toArray(String[]::new)));
        List<String> dropped = types.stream().filter(t -> !relationLike(t)).toList();
        p("    除外種別 = " + dropped);

        // --- 5. ビューのメタデータ ---
        p("\n[5] ビューに対する標準メタデータ");
        for (String view : viewNames) {
            if (!byType.values().stream().anyMatch(l -> l.contains(view))) continue;
            p("  - " + view + "  (TABLE_TYPE=" + typeOf(byType, view) + ")");
            p("      REMARKS      : " + remarks(md, catalog, schema, view));
            p("      getColumns   : " + columnDump(md, catalog, schema, view));
            p("      getPrimaryKeys: " + safeCount(() -> md.getPrimaryKeys(catalog, schema, view)));
            p("      getIndexInfo : " + safeCount(() -> md.getIndexInfo(catalog, schema, view, false, true)));
            p("      getImportedKeys: " + safeCount(() -> md.getImportedKeys(catalog, schema, view)));
        }
        p("");
    }

    /** 提案ルール本体。 */
    private static boolean relationLike(String type) {
        String t = type == null ? "" : type.toUpperCase(Locale.ROOT);
        if (t.contains("SYSTEM")) return false;
        return t.contains("TABLE") || t.contains("VIEW");
    }

    private static int count(DatabaseMetaData md, String catalog, String schema, String[] types)
            throws SQLException {
        int n = 0;
        try (ResultSet rs = md.getTables(catalog, schema, "%", types)) {
            while (rs.next()) {
                n++;
            }
        }
        return n;
    }

    private static String typeOf(Map<String, List<String>> byType, String name) {
        for (Map.Entry<String, List<String>> e : byType.entrySet()) {
            if (e.getValue().contains(name)) return e.getKey();
        }
        return "?";
    }

    private static String remarks(DatabaseMetaData md, String catalog, String schema, String name) {
        try (ResultSet rs = md.getTables(catalog, schema, name, null)) {
            if (rs.next()) return String.valueOf(rs.getString("REMARKS"));
        } catch (SQLException e) {
            return "ERROR: " + e.getMessage();
        }
        return "(not found)";
    }

    private static String columnDump(DatabaseMetaData md, String catalog, String schema, String name) {
        Map<String, String> cols = new LinkedHashMap<>();
        try (ResultSet rs = md.getColumns(catalog, schema, name, "%")) {
            while (rs.next()) {
                cols.put(rs.getString("COLUMN_NAME"),
                        rs.getString("TYPE_NAME")
                                + " nullable=" + q(rs.getString("IS_NULLABLE"))
                                + " autoinc=" + q(rs.getString("IS_AUTOINCREMENT"))
                                + " gen=" + q(rs.getString("IS_GENERATEDCOLUMN"))
                                + " remarks=" + q(rs.getString("REMARKS")));
            }
        } catch (SQLException e) {
            return "ERROR: " + e.getMessage();
        }
        if (cols.isEmpty()) return "(0 columns)";
        StringBuilder sb = new StringBuilder(cols.size() + " columns");
        cols.forEach((k, v) -> sb.append("\n          ").append(k).append(" : ").append(v));
        return sb.toString();
    }

    private static String q(String s) {
        return s == null ? "null" : "\"" + s + "\"";
    }

    private interface Rs {
        ResultSet get() throws SQLException;
    }

    private static String safeCount(Rs supplier) {
        try (ResultSet rs = supplier.get()) {
            int n = 0;
            while (rs.next()) {
                n++;
            }
            return n + " rows";
        } catch (SQLException | RuntimeException e) {
            return "THROWS: " + e.getClass().getSimpleName() + " " + e.getMessage();
        }
    }

    private static String sample(List<String> names) {
        List<String> sorted = new ArrayList<>(names);
        sorted.sort(String::compareTo);
        List<String> head = sorted.subList(0, Math.min(4, sorted.size()));
        return String.join(", ", head) + (sorted.size() > 4 ? ", ..." : "");
    }

    private static void exec(Connection conn, String... statements) throws SQLException {
        try (Statement st = conn.createStatement()) {
            for (String s : statements) {
                st.execute(s);
            }
        }
    }

    private static void execIgnoring(Connection conn, String... statements) {
        DbTestSupport.runIgnoring(conn, statements);
    }
}
