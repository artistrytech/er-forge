package erd.core.io;

import com.fasterxml.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.util.Iterator;
import java.util.Map;

/**
 * 汎用 JSON 値（未知キー・dialect）の決定論的な出力。
 *
 * <p>規則: スカラーとスカラーのみの配列はインライン、オブジェクトと複合配列はブロック。
 * インラインの文脈（1行オブジェクトの中）では常にインライン。
 */
public final class JsValues {
    private JsValues() {}

    /** インライン形。 */
    public static String inline(JsonNode v) {
        if (v == null || v.isNull()) return "null";
        if (v.isTextual()) return JsText.quote(v.textValue());
        if (v.isBoolean()) return v.booleanValue() ? "true" : "false";
        if (v.isNumber()) return number(v);
        if (v.isArray()) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < v.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append(inline(v.get(i)));
            }
            return sb.append("]").toString();
        }
        if (v.isObject()) {
            if (v.isEmpty()) return "{}";
            StringBuilder sb = new StringBuilder("{ ");
            Iterator<Map.Entry<String, JsonNode>> it = v.fields();
            boolean first = true;
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                if (!first) sb.append(", ");
                first = false;
                sb.append(JsText.key(e.getKey())).append(": ").append(inline(e.getValue()));
            }
            return sb.append(" }").toString();
        }
        throw new IllegalArgumentException("unsupported node type: " + v.getNodeType());
    }

    /** ブロック文脈で複数行にすべき値か。 */
    public static boolean isBlock(JsonNode v) {
        if (v == null) return false;
        if (v.isObject()) return !v.isEmpty();
        if (v.isArray()) {
            for (JsonNode el : v) {
                if (el.isObject() || el.isArray()) return true;
            }
        }
        return false;
    }

    private static String number(JsonNode v) {
        if (v.isIntegralNumber()) return v.bigIntegerValue().toString();
        // 小数はモデル上の値をそのまま（座標等の自前の値は整数のみ。ここに来るのは未知キー・dialect のみ）
        BigDecimal d = v.decimalValue();
        return d.toPlainString();
    }
}
