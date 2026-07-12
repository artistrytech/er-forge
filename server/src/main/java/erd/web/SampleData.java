package erd.web;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;

/**
 * 同梱サンプルデータ（jar 内 /erd-sample/**。GenerateSampleData が生成）の書き出し。
 * ブートストラップ（§3.6）の「サンプルデータを取り込む」で使う。
 */
public final class SampleData {

    private static final String BASE = "/erd-sample/";

    /** サンプルの data/** を dataDir へ書き出し、テーブル数を返す。 */
    public static int writeTo(Path dataDir) throws IOException {
        List<String> files = fileList();
        for (String rel : files) {
            byte[] content = resource(BASE + "data/" + rel);
            Path target = dataDir.resolve(rel);
            Files.createDirectories(target.getParent());
            Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
            Files.write(tmp, content);
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        }
        return (int) files.stream().filter(f -> f.startsWith("schema/")).count();
    }

    private static List<String> fileList() throws IOException {
        String list = new String(resource(BASE + "files.txt"), StandardCharsets.UTF_8);
        return list.lines().map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    private static byte[] resource(String path) throws IOException {
        try (InputStream in = SampleData.class.getResourceAsStream(path)) {
            if (in == null) {
                throw new IOException("missing bundled resource: " + path);
            }
            return in.readAllBytes();
        }
    }

    private SampleData() { }
}
