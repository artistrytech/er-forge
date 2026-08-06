package erd.web;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 閲覧用 ZIP の書き出し（`erd export` と GUI。§3.2 / A-11）。 */
class ViewerExportTest {

    private static final String PREFIX = ViewerExport.DEFAULT_PREFIX;

    /** 配布物を展開した直後 + データあり、の状態を作る。 */
    private static Path erdRoot(Path tmp) throws IOException {
        Path root = tmp.resolve("erd");
        write(root.resolve("index.html"), "<!doctype html><title>viewer</title>");
        write(root.resolve("workspaces.js"), "ERD.workspaces([{ id: \"sales\", name: \"売上\" },]);\n");
        write(root.resolve("THIRD-PARTY-NOTICES.txt"), "notices");
        write(root.resolve("config.js"), "ERD.config({ drivers: {} });\n");
        write(root.resolve("erd-server.jar"), "jar");
        write(root.resolve("erd.sh"), "#!/bin/sh\n");
        write(root.resolve("erd.bat"), "@echo off\n");
        write(root.resolve(".gitignore"), ".local/\n");
        write(root.resolve("drivers/postgresql-42.7.4.jar"), "driver");
        write(root.resolve("drivers/README.txt"), "readme");
        // 個人データ（接続情報）。ここが漏れたら事故なので、必ず除外されること
        write(root.resolve(".local/workspace-sales/connection.local.json"),
                "{\"url\":\"jdbc:postgresql://prod/db\",\"password\":\"s3cret\"}");
        write(root.resolve("workspace-sales/data/manifest.js"), "ERD.manifest({});\n");
        write(root.resolve("workspace-sales/data/schema/public/users.js"), "ERD.table({});\n");
        write(root.resolve("workspace-billing/data/manifest.js"), "ERD.manifest({});\n");
        return root;
    }

    private static void write(Path file, String content) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, content, StandardCharsets.UTF_8);
    }

    private static List<String> entries(Path zip) throws IOException {
        try (ZipFile file = new ZipFile(zip.toFile())) {
            List<String> names = new ArrayList<>();
            for (ZipEntry entry : file.stream().toList()) {
                names.add(entry.getName());
            }
            return names;
        }
    }

    @Test
    @DisplayName("閲覧に要るものだけを入れ、接続情報・jar・ドライバは入れない")
    void bundlesViewerFilesOnly(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);

        Path zip = ViewerExport.create(root, PREFIX, List.of());

        assertTrue(zip.getFileName().toString().startsWith(PREFIX + "-"), zip.toString());
        assertEquals(root, zip.getParent());
        assertEquals(List.of(
                "index.html",
                "workspaces.js",
                "THIRD-PARTY-NOTICES.txt",
                "workspace-billing/data/manifest.js",
                "workspace-sales/data/manifest.js",
                "workspace-sales/data/schema/public/users.js"),
                entries(zip));
    }

    @Test
    @DisplayName("ワークスペースを選ぶと、選んだ分だけが入る")
    void bundlesSelectedWorkspaces(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);

        Path zip = ViewerExport.create(root, PREFIX, List.of("sales"));

        assertEquals(List.of(
                "index.html",
                "workspaces.js",
                "THIRD-PARTY-NOTICES.txt",
                "workspace-sales/data/manifest.js",
                "workspace-sales/data/schema/public/users.js"),
                entries(zip));
    }

    @Test
    @DisplayName("知らないワークスペースを指定したら、作らずに理由を返す")
    void rejectsUnknownWorkspace(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);

        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> ViewerExport.create(root, PREFIX, List.of("sales", "nope")));

        assertTrue(e.getMessage().contains("nope"), e.getMessage());
        assertTrue(e.getMessage().contains("sales"), "選べる ID を示すこと: " + e.getMessage());
        assertNoZip(root);
    }

    @Test
    @DisplayName("プレフィックスは任意に付けられる（日本語・空白も可）")
    void usesGivenPrefix(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);

        Path zip = ViewerExport.create(root, "売上 ER図", List.of());

        assertTrue(zip.getFileName().toString().startsWith("売上 ER図-"), zip.toString());
        assertTrue(zip.getFileName().toString().endsWith(".zip"), zip.toString());
        assertTrue(Files.isRegularFile(zip));
    }

    @Test
    @DisplayName("ファイル名にできないプレフィックスは理由付きで弾く")
    void validatesPrefix() {
        assertNull(ViewerExport.prefixError(ViewerExport.DEFAULT_PREFIX));
        assertNull(ViewerExport.prefixError("売上 ER図_v2.1"));

        assertNotNull(ViewerExport.prefixError(""));
        assertNotNull(ViewerExport.prefixError(null));
        assertNotNull(ViewerExport.prefixError("a/b"));
        assertNotNull(ViewerExport.prefixError("a\\b"));
        assertNotNull(ViewerExport.prefixError("a:b"));
        assertNotNull(ViewerExport.prefixError("a*b"));
        assertNotNull(ViewerExport.prefixError("a?b"));
        assertNotNull(ViewerExport.prefixError("a\"b"));
        assertNotNull(ViewerExport.prefixError("a<b"));
        assertNotNull(ViewerExport.prefixError("a|b"));
        assertNotNull(ViewerExport.prefixError("a\nb"));
        assertNotNull(ViewerExport.prefixError(" leading"));
        assertNotNull(ViewerExport.prefixError("trailing "));
        assertNotNull(ViewerExport.prefixError("trailing."));
        assertNotNull(ViewerExport.prefixError("CON"));
        assertNotNull(ViewerExport.prefixError("nul.zip"));
        assertNotNull(ViewerExport.prefixError("x".repeat(65)));
    }

    @Test
    @DisplayName("書き出しは元のディレクトリを変えない（ZIP を1つ増やすだけ）")
    void doesNotTouchTheProject(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        String before = Hashes.fingerprint(root.resolve("workspace-sales/data"));

        ViewerExport.create(root, PREFIX, List.of());

        assertEquals(before, Hashes.fingerprint(root.resolve("workspace-sales/data")));
        assertTrue(Files.isRegularFile(root.resolve(".local/workspace-sales/connection.local.json")));
    }

    @Test
    @DisplayName("index.html が無ければ何も作らずに失敗する")
    void requiresIndexHtml(@TempDir Path tmp) throws Exception {
        Path root = erdRoot(tmp);
        Files.delete(root.resolve("index.html"));

        IOException e = assertThrows(IOException.class,
                () -> ViewerExport.create(root, PREFIX, List.of()));

        assertTrue(e.getMessage().contains("index.html"), e.getMessage());
        assertNoZip(root);
    }

    private static void assertNoZip(Path root) throws IOException {
        try (var list = Files.list(root)) {
            assertFalse(list.anyMatch(p -> p.getFileName().toString().endsWith(".zip")),
                    "失敗したのに中途半端な ZIP を残さないこと");
        }
    }
}
