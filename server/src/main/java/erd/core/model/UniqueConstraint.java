package erd.core.model;

import java.util.List;

public record UniqueConstraint(String name, List<String> columns) {
    public UniqueConstraint {
        columns = List.copyOf(columns);
    }
}
