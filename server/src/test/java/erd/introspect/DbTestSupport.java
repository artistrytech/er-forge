package erd.introspect;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/**
 * 追加 DB 検証（Phase 7）の共通ヘルパ。
 *
 * <p>DDL は {@code dev-db/ddl/*.sql}（{@code devdb.dir} システムプロパティで場所を渡す）から読む。
 * 手動 GUI 検証（docker compose）と自動テストで同じ DDL を共有し、二重管理を避ける。
 *
 * <p>SQL Server / Oracle のテストは docker compose が起動していないと skip する。
 * その判定に使えるよう、接続失敗を素直に伝える {@link #tryOpen} を用意する。
 */
final class DbTestSupport {

    private DbTestSupport() {}

    /** {@code dev-db/ddl/<name>.sql} を読み込む。 */
    static String ddl(String name) {
        String dir = System.getProperty("devdb.dir");
        if (dir == null) throw new IllegalStateException("devdb.dir system property is not set");
        try {
            return Files.readString(Path.of(dir, "ddl", name + ".sql"));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * 接続を試み、失敗（ドライバ未ロード・DB 未起動）なら {@code null} を返す。
     * テスト側は {@code assumeTrue(conn != null)} で skip 判定に使う。
     */
    static Connection tryOpen(String url, String user, String password,
                              java.util.Properties props) {
        java.util.Properties p = props == null ? new java.util.Properties() : props;
        if (user != null) p.put("user", user);
        if (password != null) p.put("password", password);
        // DB 未起動時に長く待たされないよう、ログイン待ちを短く切る（skip 判定を速くする）
        int prev = java.sql.DriverManager.getLoginTimeout();
        java.sql.DriverManager.setLoginTimeout(5);
        try {
            return java.sql.DriverManager.getConnection(url, p);
        } catch (SQLException e) {
            return null;
        } finally {
            java.sql.DriverManager.setLoginTimeout(prev);
        }
    }

    /** セミコロン終端の DDL スクリプトを1文ずつ実行する（文中にセミコロンを含めない前提）。 */
    static void runScript(Connection conn, String script) throws SQLException {
        try (Statement st = conn.createStatement()) {
            for (String stmt : split(script)) {
                st.execute(stmt);
            }
        }
    }

    /** 各文を実行するが、SQL エラーは黙って飲む（DROP のような「無ければ無視」用）。 */
    static void runIgnoring(Connection conn, String... statements) {
        try (Statement st = conn.createStatement()) {
            for (String stmt : statements) {
                try {
                    st.execute(stmt);
                } catch (SQLException ignored) {
                    // 対象が存在しない等。冪等なクリーンアップのため無視する
                }
            }
        } catch (SQLException ignored) {
            // createStatement 失敗は後続の本処理で顕在化するのでここでは無視
        }
    }

    private static List<String> split(String script) {
        List<String> out = new ArrayList<>();
        for (String raw : script.split(";")) {
            String stmt = stripComments(raw).trim();
            if (!stmt.isEmpty()) out.add(stmt);
        }
        return out;
    }

    /** 行コメント（{@code -- ...}）を落とす。ブロックコメントは DDL では使わない。 */
    private static String stripComments(String s) {
        StringBuilder sb = new StringBuilder();
        for (String line : s.split("\n", -1)) {
            int idx = line.indexOf("--");
            sb.append(idx >= 0 ? line.substring(0, idx) : line).append('\n');
        }
        return sb.toString();
    }
}
