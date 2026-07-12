package erd.core.model;

import java.util.List;

/** 外部制約の参照先。 */
public record Ref(String table, List<String> columns) {
    public Ref {
        columns = List.copyOf(columns);
    }
}
