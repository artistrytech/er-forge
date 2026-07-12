package erd.core.model;

import com.fasterxml.jackson.annotation.JsonValue;

/** 座標。グリッドスナップ（8px）+ 整数化済みの値のみを保持する。JSON 上は [x, y]。 */
public record Point(int x, int y) {
    @JsonValue
    public int[] toArray() {
        return new int[] { x, y };
    }
}
