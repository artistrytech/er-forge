package erd.core.model;

import java.util.List;

/**
 * 論理外部制約（human-owned）。DB に FK は無いが論理的な参照関係。
 * onDelete / onUpdate は持たない（DB に制約が無い以上、参照動作は存在しない）。
 */
public record LogicalForeignKey(String name, List<String> columns, Ref ref, String notes) {
    public LogicalForeignKey {
        columns = List.copyOf(columns);
    }
}
