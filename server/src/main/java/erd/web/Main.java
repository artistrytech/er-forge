package erd.web;

import erd.core.migrate.MigrationRunner;
import erd.core.migrate.NewerDataException;

import java.awt.Desktop;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;

/**
 * エントリポイント（§8.1）。カレントディレクトリをプロジェクトルート（erd/）として扱う。
 *
 * <p>サブコマンドは <b>run</b>（既定。サーバー起動）と <b>export</b>（閲覧用 ZIP の書き出し。§3.2）
 * の 2 つだけ。<b>編集操作にフラグは足さない</b>（全操作は GUI。§1.2）。export を CLI に置くのは、
 * 「サーバーを起動せずに成果物を作る」という、GUI では表現できない操作だからである。
 * 引数なしは run と同じ（起動スクリプトのダブルクリックで従来どおり起動する）。
 *
 * <p>テスト・自動化用に環境変数も許す:
 * ERD_PORT（基点ポート）/ ERD_NO_BROWSER（自動オープン抑止）/ ERD_TOKEN（トークン固定）。
 */
public final class Main {

    private static final int DEFAULT_PORT = 5321;

    public static void main(String[] args) {
        Path root = Path.of("").toAbsolutePath();
        String command = args.length == 0 ? "run" : args[0].toLowerCase(Locale.ROOT);
        String[] options = args.length == 0 ? new String[0]
                : java.util.Arrays.copyOfRange(args, 1, args.length);
        switch (command) {
            case "run" -> {
                requireNoOptions(options);
                run(root);
            }
            case "export" -> export(root, options);
            case "help", "-h", "--help" -> usage(System.out);
            default -> fail("Unknown command: " + args[0]);
        }
    }

    private static void usage(java.io.PrintStream out) {
        out.println("Usage: erd [run|export] [options]");
        out.println("  run     Start the server and open the browser (default; same as no argument)");
        out.println("  export  Write a viewer-only ZIP (index.html + data) into this directory,");
        out.println("          for sharing with people who do not use Git or Java");
        out.println();
        out.println("Options for export:");
        out.println("  --prefix=<name>       File name prefix (default: " + ViewerExport.DEFAULT_PREFIX + ").");
        out.println("                        The file is named <prefix>-<timestamp>.zip");
        out.println("  --workspaces=<a,b>    Workspaces to include (default: all)");
    }

    /** 使い方を出して終了する（引数の誤りは黙って進めない）。 */
    private static void fail(String message) {
        System.err.println(message);
        usage(System.err);
        System.exit(2);
    }

    private static void requireNoOptions(String[] options) {
        if (options.length > 0) fail("Too many arguments: " + String.join(" ", options));
    }

    /**
     * 閲覧用の静的リソースを ZIP にまとめる（サーバーは起動しない）。
     *
     * <p>受け付けるのは {@code --prefix=<name>} と {@code --workspaces=<a,b>} だけ。
     * 空白区切り（{@code --prefix foo}）も同じものとして扱う（GUI が提示する形は = のほう）。
     */
    private static void export(Path root, String[] options) {
        String prefix = ViewerExport.DEFAULT_PREFIX;
        List<String> workspaces = List.of();
        for (int i = 0; i < options.length; i++) {
            String option = options[i];
            String name = option;
            String value = null;
            int eq = option.indexOf('=');
            if (eq >= 0) {
                name = option.substring(0, eq);
                value = option.substring(eq + 1);
            } else if (i + 1 < options.length && !options[i + 1].startsWith("--")) {
                value = options[++i];
            }
            switch (name) {
                case "--prefix" -> {
                    if (value == null) {
                        fail("Missing value: --prefix=<name>");
                        return;
                    }
                    prefix = value;
                }
                case "--workspaces" -> {
                    if (value == null) {
                        fail("Missing value: --workspaces=<a,b>");
                        return;
                    }
                    workspaces = java.util.Arrays.stream(value.split(","))
                            .map(String::trim).filter(s -> !s.isEmpty()).toList();
                }
                default -> {
                    fail("Unknown option: " + option);
                    return;
                }
            }
        }

        String error = ViewerExport.prefixError(prefix);
        if (error != null) {
            System.err.println("Invalid --prefix: " + error);
            System.exit(2);
            return;
        }
        try {
            Path zip = ViewerExport.create(root, prefix, workspaces);
            System.out.println("Exported: " + zip);
            System.out.println("Extract it anywhere and open index.html in a browser (no Java needed).");
        } catch (IllegalArgumentException e) {
            System.err.println("Invalid --workspaces: " + e.getMessage());
            System.exit(2);
        } catch (Exception e) {
            System.err.println("Export failed: " + e.getMessage());
            System.exit(1);
        }
    }

    private static void run(Path root) {
        // データ形式の自動移行（§3.5）を全ワークスペースに対して行う
        for (String id : WorkspaceStore.scan(root)) {
            migrate(root, id);
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
     * ワークスペース1つ分の自動移行（§3.5）。
     *
     * <p><b>データの方が新しくてもサーバーは起動する</b>（そのワークスペースだけを触らない）。
     * 複数ワークスペースでは「1つだけ新しい」状態が起こりうるため、全体の起動を止めない。
     * ビューア側はバージョン不一致をバナーで検出し、そのワークスペースを描画しない（A-04）。
     */
    private static void migrate(Path root, String workspaceId) {
        Path dir = WorkspaceStore.dir(root, workspaceId);
        if (!Files.exists(dir.resolve("data/manifest.js"))) return;
        try {
            MigrationRunner.Result result = new MigrationRunner()
                    .run(dir, WorkspaceStore.privateDir(root, workspaceId).resolve("backup"));
            if (result.migrated()) {
                System.out.println("Migrated data format of workspace \"" + workspaceId + "\" from v"
                        + result.fromVersion() + " to v" + result.toVersion() + ". "
                        + "Consider committing this migration separately.");
            }
        } catch (NewerDataException e) {
            System.err.println("Workspace \"" + workspaceId + "\": " + e.getMessage()
                    + " This workspace is left untouched.");
        } catch (RuntimeException e) {
            // 壊れたデータでも閲覧（欠損表示）はできるため、起動自体は続ける
            System.err.println("Warning: Could not inspect workspace \"" + workspaceId + "\": "
                    + e.getMessage());
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
