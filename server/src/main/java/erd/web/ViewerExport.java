package erd.web;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 閲覧用の静的リソース一式を ZIP にまとめる（`erd export` と GUI のツールメニュー。§3.2 / A-11）。
 *
 * <p>用途は「Git を使わない相手に閲覧環境ごと渡す」こと。展開して {@code index.html} を
 * 開けば、Java もサーバーも無しで ER 図・テーブルカタログが見られる（静的モード。§9.6）。
 *
 * <p><b>入れるものは閲覧に要るものだけ</b>で、それ以外は渡してはいけないものとして扱う:
 * <ul>
 *   <li>{@code erd-server.jar}・{@code erd.sh}・{@code erd.bat} — 閲覧に要らない（サーバーは配らない）
 *   <li>{@code .local/} — <b>DB 接続情報</b>。社外に出す ZIP に入れては絶対にならない
 *   <li>{@code drivers/} — 各自が取得するもので、再配布のライセンス問題もある（§7.2）
 *   <li>{@code config.js}（ルート） — ドライバ設定であり閲覧には使われない
 *   <li>{@code .gitignore} / {@code .gitattributes} — 配布先の ZIP は Git 管理しない
 * </ul>
 *
 * <p>{@code THIRD-PARTY-NOTICES.txt} は<b>入れる</b>。この ZIP は {@code index.html}（他者の
 * OSS をインライン化した単一 HTML）を再配布しているため、告知の同梱が義務になる（§3.1）。
 *
 * <p><b>CLI と GUI はこのクラスを共有する</b>。ファイル名の規則も除外の線引きも 1 か所にしか
 * 無いようにして、経路によって中身が変わることを防ぐ。
 */
final class ViewerExport {

    static final String DEFAULT_PREFIX = "ERForge-viewer";

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");
    private static final int PREFIX_MAX = 64;

    /** どの OS でもファイル名に使えない文字（Windows が最も厳しいのでそれに合わせる）。 */
    private static final String FORBIDDEN = "\\/:*?\"<>|";

    /** Windows の予約デバイス名。拡張子を付けても予約のままなので、前方一致で弾く。 */
    private static final Pattern RESERVED =
            Pattern.compile("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?$");

    /** ルート直下から入れるファイル（無いものは黙って飛ばす。index.html だけは必須）。 */
    private static final List<String> ROOT_FILES =
            List.of("index.html", WorkspaceStore.REGISTRY, "THIRD-PARTY-NOTICES.txt");

    private ViewerExport() {}

    // ------------------------------------------------------------- validation

    /**
     * ZIP 名のプレフィックスの検査。**不正なら理由（英語1行）を返し、正常なら null を返す。**
     * CLI も API もここを通す（ビューア側にも同じ規則の即時チェックがあるが、正はこちら）。
     *
     * <p>「ファイル名に使える文字ならなんでもよい」が要件なので、日本語も空白も通す。
     * 弾くのは、実際にファイルを作れない・作ると事故になるものだけである。
     */
    static String prefixError(String prefix) {
        if (prefix == null || prefix.isEmpty()) {
            return "The prefix must not be empty.";
        }
        if (prefix.length() > PREFIX_MAX) {
            return "The prefix must be " + PREFIX_MAX + " characters or shorter.";
        }
        for (int i = 0; i < prefix.length(); i++) {
            char c = prefix.charAt(i);
            if (c < 0x20 || c == 0x7f) return "The prefix must not contain control characters.";
            if (FORBIDDEN.indexOf(c) >= 0) {
                return "The prefix must not contain any of " + FORBIDDEN;
            }
        }
        // 先頭・末尾の空白と末尾のドットは Windows が黙って落とすため、作った名前と実物がずれる
        if (prefix.startsWith(" ") || prefix.endsWith(" ") || prefix.endsWith(".")) {
            return "The prefix must not start or end with a space, or end with a dot.";
        }
        if (RESERVED.matcher(prefix.toLowerCase(Locale.ROOT)).matches()) {
            return "The prefix must not be a reserved device name (CON, PRN, NUL, COM1, ...).";
        }
        return null;
    }

    /** 書き出すワークスペース。空指定は「全部」。走査順に揃えるので ZIP の中身は安定する。 */
    static List<String> resolveWorkspaces(Path root, List<String> requested) {
        List<String> all = WorkspaceStore.scan(root);
        if (requested == null || requested.isEmpty()) return all;
        List<String> unknown = requested.stream().filter(id -> !all.contains(id)).toList();
        if (!unknown.isEmpty()) {
            throw new IllegalArgumentException("Unknown workspace: " + String.join(", ", unknown)
                    + (all.isEmpty() ? "" : " (available: " + String.join(", ", all) + ")"));
        }
        return all.stream().filter(requested::contains).toList();
    }

    /** {@code <prefix>-<timestamp>.zip}。 */
    static String fileName(String prefix) {
        return prefix + "-" + LocalDateTime.now().format(STAMP) + ".zip";
    }

    // ----------------------------------------------------------------- write

    /**
     * CLI 用。ルート直下に ZIP を作り、そのパスを返す。
     *
     * @param prefix     ファイル名のプレフィックス（{@link #prefixError} を通っていること）
     * @param workspaces 書き出すワークスペース ID。空なら全部
     */
    static Path create(Path root, String prefix, List<String> workspaces) throws IOException {
        List<Entry> entries = collect(root, resolveWorkspaces(root, workspaces));
        Path zip = root.resolve(fileName(prefix));
        try (OutputStream out = Files.newOutputStream(zip)) {
            write(entries, out);
        } catch (IOException e) {
            // 中途半端な ZIP を残さない（失敗したのに配れそうなファイルがあるのが一番危ない）
            Files.deleteIfExists(zip);
            throw e;
        }
        return zip;
    }

    /** GUI 用。HTTP のレスポンスへ直接流す（サーバー側にファイルを残さない）。 */
    static void writeTo(Path root, List<String> workspaces, OutputStream out) throws IOException {
        write(collect(root, resolveWorkspaces(root, workspaces)), out);
    }

    private static void write(List<Entry> entries, OutputStream out) throws IOException {
        try (ZipOutputStream zos = new ZipOutputStream(out)) {
            for (Entry e : entries) {
                ZipEntry entry = new ZipEntry(e.name());
                entry.setLastModifiedTime(Files.getLastModifiedTime(e.file()));
                zos.putNextEntry(entry);
                Files.copy(e.file(), zos);
                zos.closeEntry();
            }
        }
    }

    private static List<Entry> collect(Path root, List<String> workspaces) throws IOException {
        Path index = root.resolve("index.html");
        if (!Files.isRegularFile(index)) {
            throw new IOException("index.html not found in " + root
                    + " (run this from the directory where the tool was extracted)");
        }
        // レジストリ（workspaces.js）を走査結果に合わせてから固める。静的モードはこの 1 本で
        // ワークスペースを発見するため、古い / 無いまま詰めると「開いても何も出ない ZIP」になる。
        // サーバー起動時と同じ同期処理であり、差分が出たらコミット対象になる（生成物）
        new WorkspaceStore().list(root);

        List<Entry> entries = new ArrayList<>();
        for (String name : ROOT_FILES) {
            Path file = root.resolve(name);
            if (Files.isRegularFile(file)) entries.add(new Entry(name, file));
        }
        for (String id : workspaces) {
            collectData(root, id, entries);
        }
        return entries;
    }

    /** {@code workspace-<id>/data/**} を丸ごと（順序を固定して）拾う。 */
    private static void collectData(Path root, String id, List<Entry> out) throws IOException {
        Path dataDir = WorkspaceStore.dataDir(root, id);
        if (!Files.isDirectory(dataDir)) return;
        Path base = root.relativize(dataDir);
        try (Stream<Path> walk = Files.walk(dataDir)) {
            List<Path> files = walk.filter(Files::isRegularFile).sorted().toList();
            for (Path file : files) {
                out.add(new Entry(entryName(base.resolve(dataDir.relativize(file))), file));
            }
        }
    }

    /** ZIP の中の区切りは常に "/"（Windows で作った ZIP を macOS で開いても壊れないように）。 */
    private static String entryName(Path relative) {
        return relative.toString().replace('\\', '/');
    }

    private record Entry(String name, Path file) {}
}
