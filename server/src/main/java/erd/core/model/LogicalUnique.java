package erd.core.model;

import java.util.List;

/** 論理一意制約（human-owned）。DB に制約は無いが運用上一意である組。 */
public record LogicalUnique(String name, List<String> columns, String notes) {
    public LogicalUnique {
        columns = List.copyOf(columns);
    }
}
