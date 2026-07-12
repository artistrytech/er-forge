package erd.core.io;

import java.util.List;

/** パース結果 + 非致命の警告（V-2 / V-3）。 */
public record Parsed<T>(T value, List<String> warnings) {
    public Parsed {
        warnings = List.copyOf(warnings);
    }
}
