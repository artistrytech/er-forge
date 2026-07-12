package erd.core.fixtures;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

public final class FixtureDir {
    private FixtureDir() {}

    public static Path dir() {
        String p = System.getProperty("fixtures.dir");
        if (p == null) throw new IllegalStateException("system property fixtures.dir is not set");
        return Path.of(p);
    }

    public static String read(String name) {
        try {
            return new String(Files.readAllBytes(dir().resolve(name)), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static List<Path> glob(String suffix) {
        try (Stream<Path> s = Files.list(dir())) {
            return s.filter(p -> p.getFileName().toString().endsWith(suffix)).sorted().toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
