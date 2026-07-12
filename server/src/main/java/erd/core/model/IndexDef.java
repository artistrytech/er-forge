package erd.core.model;

import java.util.List;

public record IndexDef(String name, List<String> columns, boolean unique) {
    public IndexDef {
        columns = List.copyOf(columns);
    }
}
