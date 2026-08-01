package erd.introspect;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 追加 DB 検証（Phase 7）の共通ヘルパ。
 *
 * <p>初期スキーマは {@code dev-db/<product>/migrations/000_init.sql}（{@code devdb.dir}
 * システムプロパティで dev-db の場所を渡す）から読む。手動 GUI 検証（docker compose）と
 * 自動テストで同じファイルを共有し、二重管理を避ける。中身は PostgreSQL 版
 * （同梱サンプルの元データ。26テーブル）を各製品の方言へ移植したもの。
 *
 * <p>MySQL / SQL Server / Oracle のテストは docker compose が起動していないと skip する。
 * その判定に使えるよう、接続失敗を素直に伝える {@link #tryOpen} を用意する。
 */
final class DbTestSupport {

    private DbTestSupport() {}

    /**
     * 000_init.sql が作るテーブル（作成順）。3製品とも同じ構成を移植してある。
     *
     * <p>内省結果は名前の自然順（{@code Comparator.naturalOrder()}）に並ぶため、比較する側で
     * {@code sorted()} してから使う。Oracle は識別子が大文字に畳まれ、{@code '_'} と英大文字の
     * 大小関係が逆転する（{@code 'S' < '_'}）ので、**大文字化してから**並べ替えること。
     */
    static final List<String> SAMPLE_TABLES = List.of(
            "users", "user_profiles", "user_addresses", "user_sessions", "roles", "user_roles",
            "product_categories", "products", "product_images", "inventories", "product_reviews",
            "product_tags", "product_tag_mappings",
            "orders", "order_items", "shipments", "order_status_logs", "order_cancellations",
            "payment_methods", "payments", "payment_histories", "refunds",
            "points", "point_transactions", "point_campaigns", "point_bonus_rules");

    /** 内省結果と比較するための期待値（自然順に整列済み）。 */
    static List<String> sampleTablesSorted(boolean upperCase) {
        return SAMPLE_TABLES.stream()
                .map(t -> upperCase ? t.toUpperCase(java.util.Locale.ROOT) : t)
                .sorted()
                .toList();
    }

    /** {@code dev-db/<product>/migrations/000_init.sql} を読み込む。 */
    static String initSql(String product) {
        String dir = System.getProperty("devdb.dir");
        if (dir == null) throw new IllegalStateException("devdb.dir system property is not set");
        try {
            return Files.readString(Path.of(dir, product, "migrations", "000_init.sql"));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * スクリプト中の {@code CREATE TABLE} を書かれた順に拾う（スキーマ修飾は落とす）。
     *
     * <p>26テーブルの DROP をテスト側に手で並べると、DDL を1つ足すたびに書き漏らして
     * 「前回の残骸が残ったまま内省する」ことになる。冪等化はここから導出する。
     */
    static List<String> createdTables(String script) {
        List<String> names = new ArrayList<>();
        Matcher m = Pattern.compile("(?im)^\\s*CREATE\\s+TABLE\\s+([\\w.\"]+)").matcher(script);
        while (m.find()) {
            String name = m.group(1).replace("\"", "");
            int dot = name.lastIndexOf('.');
            names.add(dot >= 0 ? name.substring(dot + 1) : name);
        }
        return names;
    }

    /**
     * スクリプトが作るテーブルを**作成と逆順に**落とす（子から先に消えるので FK に触らない）。
     * 存在しないものは黙って飛ばす。
     *
     * @param qualifier スキーマ修飾（{@code "dbo."} など。不要なら空文字）
     * @param suffix    製品ごとの後置（Oracle の {@code " CASCADE CONSTRAINTS"} など。不要なら空文字）
     */
    static void dropAll(Connection conn, String script, String qualifier, String suffix) {
        List<String> tables = new ArrayList<>(createdTables(script));
        Collections.reverse(tables);
        String[] statements = tables.stream()
                .map(t -> "DROP TABLE " + qualifier + t + suffix)
                .toArray(String[]::new);
        runIgnoring(conn, statements);
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
