package erd.introspect;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Maven リポジトリからの JDBC ドライバ jar のダウンロード（§7.2）。
 *
 * <p>設計上の狙い: 主要ドライバを配布物に<b>同梱せず</b>、config.js に宣言された座標を各メンバーが
 * 各自の {@code drivers/} へ取得する。これにより (1) 再配布に伴うライセンス問題を回避し、
 * (2) 配布 ZIP を小さく保ち、(3) チームで同じ構成を再現できる。
 *
 * <p><b>安全性</b>: 座標は {@code group:artifact:version} を厳格な文字集合に限定してパスに落とす
 * （{@code ..} やスラッシュを混ぜたパストラバーサルを禁止）。リポジトリ URL は http(s) のみ許可。
 * ダウンロード後は Maven の {@code .sha1} と照合する（取得できた場合。改竄よりも破損検知が主目的）。
 */
public final class DriverDownloader {

    /** group:artifact:version。各セグメントは jar 名・URL パスに安全な文字だけを許す。 */
    private static final Pattern SEGMENT = Pattern.compile("[A-Za-z0-9_.-]+");

    public record Coordinate(String group, String artifact, String version) {
        public String jarFileName() {
            return artifact + "-" + version + ".jar";
        }

        /** Maven のレイアウト: group(. → /)/artifact/version/artifact-version.jar */
        public String repositoryPath() {
            return group.replace('.', '/') + "/" + artifact + "/" + version + "/" + jarFileName();
        }
    }

    /**
     * {@code group:artifact:version} をパースし検証する。
     *
     * @return 妥当なら Coordinate、そうでなければ null
     */
    public static Coordinate parse(String coordinate) {
        if (coordinate == null) return null;
        String[] parts = coordinate.trim().split(":");
        if (parts.length != 3) return null;
        for (String p : parts) {
            if (p.isEmpty() || p.equals(".") || p.equals("..") || !SEGMENT.matcher(p).matches()) {
                return null;
            }
        }
        return new Coordinate(parts[0], parts[1], parts[2]);
    }

    /** 座標が妥当な形式か（config.js の検証に使う）。 */
    public static boolean isValidCoordinate(String coordinate) {
        return parse(coordinate) != null;
    }

    /** リポジトリ URL の正規化（末尾スラッシュを除く）。http(s) 以外は null。 */
    public static String normalizeRepository(String repository) {
        if (repository == null || repository.isBlank()) return DriverCatalog.DEFAULT_MAVEN_REPOSITORY;
        String r = repository.trim();
        String lower = r.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null;
        while (r.endsWith("/")) r = r.substring(0, r.length() - 1);
        return r;
    }

    /**
     * @param coordinate 対象の座標
     * @param ok         成功したか
     * @param fileName   保存した jar 名（成功時）
     * @param message    失敗理由 / 補足（任意）
     */
    public record Result(String coordinate, boolean ok, String fileName, String message) {}

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    /** 1件ダウンロードして {@code driversDir} に保存する。DriverManager への登録は呼び出し側で行う。 */
    public Result download(String repository, String coordinate, Path driversDir) {
        Coordinate c = parse(coordinate);
        if (c == null) {
            return new Result(coordinate, false, null, "invalid coordinate (expected group:artifact:version)");
        }
        String repo = normalizeRepository(repository);
        if (repo == null) {
            return new Result(coordinate, false, null, "invalid Maven repository URL (must be http/https)");
        }
        URI jarUri = URI.create(repo + "/" + c.repositoryPath());
        try {
            Files.createDirectories(driversDir);
            byte[] jar = fetchBytes(jarUri);
            if (jar == null) {
                return new Result(coordinate, false, null, "not found: " + jarUri);
            }
            String expected = fetchSha1(URI.create(jarUri + ".sha1"));
            if (expected != null) {
                String actual = sha1Hex(jar);
                if (!actual.equalsIgnoreCase(expected)) {
                    return new Result(coordinate, false, null,
                            "checksum mismatch (expected " + expected + ", got " + actual + ")");
                }
            }
            Path target = driversDir.resolve(c.jarFileName());
            Path tmp = Files.createTempFile(driversDir, ".dl-", ".jar.part");
            Files.write(tmp, jar);
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFailed) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
            return new Result(coordinate, true, c.jarFileName(), null);
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return new Result(coordinate, false, null, e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private byte[] fetchBytes(URI uri) throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder(uri).timeout(Duration.ofMinutes(5)).GET().build();
        HttpResponse<byte[]> res = client.send(req, HttpResponse.BodyHandlers.ofByteArray());
        if (res.statusCode() == 200) return res.body();
        if (res.statusCode() == 404) return null;
        throw new IOException("HTTP " + res.statusCode() + " for " + uri);
    }

    /** .sha1 は「40桁hex」または「40桁hex  ファイル名」。取得失敗時は null（検証をスキップ）。 */
    private String fetchSha1(URI uri) {
        try {
            HttpRequest req = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(30)).GET().build();
            HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200) return null;
            String body = res.body().trim();
            if (body.isEmpty()) return null;
            String token = body.split("\\s+")[0];
            return token.length() >= 40 ? token.substring(0, 40) : null;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return null;
        }
    }

    private static String sha1Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            return HexFormat.of().formatHex(md.digest(data));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
