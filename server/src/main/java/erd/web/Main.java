package erd.web;

import erd.core.migrate.MigrationRunner;
import erd.core.migrate.NewerDataException;

import java.awt.Desktop;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Locale;

/**
 * サーバーモードのエントリポイント（§8.1）。
 *
 * <p>サブコマンド・フラグは持たない（全操作は GUI。§1.2）。カレントディレクトリを
 * プロジェクトルート（erd/）として扱う。テスト・自動化用に環境変数のみ許す:
 * ERD_PORT（基点ポート）/ ERD_NO_BROWSER（自動オープン抑止）/ ERD_TOKEN（トークン固定）。
 */
public final class Main {

    private static final int DEFAULT_PORT = 5321;

    public static void main(String[] args) {
        Path root = Path.of("").toAbsolutePath();

        // データ形式の自動移行（§3.5）。データの方が新しければ起動を中止し、一切触れない
        if (Files.exists(root.resolve("data/manifest.js"))) {
            try {
                MigrationRunner.Result result = new MigrationRunner().run(root);
                if (result.migrated()) {
                    System.out.println("Migrated data format from v" + result.fromVersion() + " to v"
                            + result.toVersion() + ". "
                            + "Consider committing this migration separately.");
                }
            } catch (NewerDataException e) {
                System.err.println(e.getMessage());
                System.exit(1);
            } catch (RuntimeException e) {
                // 壊れたデータでも閲覧（欠損表示）はできるため、起動自体は続ける
                System.err.println("Warning: Could not inspect data: " + e.getMessage());
            }
        }

        // drivers/*.jar を DriverShim 経由で DriverManager に登録する（§7.2）。
        // ここで登録しないと、URLClassLoader で読んだドライバは DriverManager から見えない
        erd.introspect.Drivers.scan(root.resolve("drivers"));

        String token = token();
        WebServer server = new WebServer(root, token);
        int basePort = envInt("ERD_PORT", DEFAULT_PORT);
        int port = server.start(basePort);

        String url = "http://127.0.0.1:" + port + "/?t=" + token;
        System.out.println("ERD server: " + url);
        System.out.println("Project: " + root);
        System.out.println("Press Ctrl+C to stop.");

        if (System.getenv("ERD_NO_BROWSER") == null) {
            openBrowser(url);
        }
    }

    /**
     * 既定は起動ごとのランダムトークン（§8.5）。
     *
     * <p>ERD_TOKEN が設定されている場合のみそれを使う。**開発時に vite dev サーバーから
     * API を叩くため**の逃げ道であり（トークンが毎回変わると dev の URL を固定できない）、
     * 配布物の既定にはしない。いずれにせよサーバーは 127.0.0.1 にしか bind しない。
     */
    private static String token() {
        String fixed = System.getenv("ERD_TOKEN");
        if (fixed != null && !fixed.isEmpty()) return fixed;
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    private static int envInt(String name, int fallback) {
        String v = System.getenv(name);
        if (v == null || v.isEmpty()) return fallback;
        try {
            return Integer.parseInt(v);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static void openBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
                return;
            }
            String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
            ProcessBuilder pb;
            if (os.contains("win")) {
                pb = new ProcessBuilder("rundll32", "url.dll,FileProtocolHandler", url);
            } else if (os.contains("mac")) {
                pb = new ProcessBuilder("open", url);
            } else {
                pb = new ProcessBuilder("xdg-open", url);
            }
            pb.start();
        } catch (Exception e) {
            System.err.println("Could not open the browser automatically. Open the URL above manually.");
        }
    }

    private Main() { }
}
