package erd.web;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** 内容ハッシュ（§8.4）。判定は mtime ではなく SHA-256 で行う。 */
public final class Hashes {

    public static String sha256(byte[] content) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return "sha256:" + HexFormat.of().formatHex(md.digest(content));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String sha256(Path file) {
        try {
            return sha256(Files.readAllBytes(file));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * data/** 全体の指紋（K-11 §6.1）。全ファイルの (パス, 内容ハッシュ) をソートして連結し、
     * さらにハッシュする。プレビュー発行時と適用直前に取り直して照合し、その間の外部変更
     * （git pull / エディタ編集 / 他の書き込み API）を検出する（TOCTOU の回避）。
     */
    public static String fingerprint(Path dataDir) {
        if (!Files.isDirectory(dataDir)) return sha256(new byte[0]);
        StringBuilder sb = new StringBuilder();
        try (java.util.stream.Stream<Path> walk = Files.walk(dataDir)) {
            walk.filter(p -> Files.isRegularFile(p) && p.toString().endsWith(".js"))
                    .map(p -> dataDir.relativize(p).toString().replace('\\', '/') + "=" + sha256(p))
                    .sorted()
                    .forEach(s -> sb.append(s).append('\n'));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return sha256(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private Hashes() { }
}
