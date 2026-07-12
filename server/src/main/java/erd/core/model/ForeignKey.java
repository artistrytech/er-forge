package erd.core.model;

import java.util.List;

/** 物理外部キー。onDelete / onUpdate の既定は "no action"（出力時は省略される）。 */
public record ForeignKey(String name, List<String> columns, Ref ref, String onDelete, String onUpdate) {
    public static final String DEFAULT_ACTION = "no action";

    public ForeignKey {
        columns = List.copyOf(columns);
        onDelete = onDelete == null ? DEFAULT_ACTION : onDelete;
        onUpdate = onUpdate == null ? DEFAULT_ACTION : onUpdate;
    }
}
