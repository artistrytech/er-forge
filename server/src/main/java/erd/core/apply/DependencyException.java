package erd.core.apply;

import java.util.List;

/** 選択の依存性違反（§5.2）。クライアントを信用せず、サーバー側でも再検証する。 */
public final class DependencyException extends RuntimeException {

    private final transient List<String> itemIds;

    public DependencyException(String message, List<String> itemIds) {
        super(message);
        this.itemIds = List.copyOf(itemIds);
    }

    public List<String> itemIds() {
        return itemIds;
    }
}
