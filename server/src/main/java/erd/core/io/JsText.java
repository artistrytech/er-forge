package erd.core.io;

import java.util.Set;
import java.util.regex.Pattern;

/**
 * JavaScript のキー引用と文字列エスケープ（Phase0 詳細設計 §2.3 / §2.5）。
 *
 * <p>非 ASCII（日本語）はエスケープしない（INV-4）。ただし U+2028 / U+2029 は
 * JS の文字列リテラル内で改行扱いになり構文エラーを生むため、必ずエスケープする。
 */
public final class JsText {
    private JsText() {}

    private static final Pattern IDENTIFIER = Pattern.compile("^[A-Za-z_$][A-Za-z0-9_$]*$");

    private static final char LINE_SEPARATOR = 0x2028;      // U+2028
    private static final char PARAGRAPH_SEPARATOR = 0x2029; // U+2029

    /**
     * JS の予約語 + 予約語に準ずる語。キーとして裸で書くと構文エラーになりうるものは
     * すべてクォートする（カラム名が default のときにファイルが壊れないように）。
     */
    private static final Set<String> RESERVED = Set.of(
            "await", "break", "case", "catch", "class", "const", "continue", "debugger",
            "default", "delete", "do", "else", "enum", "export", "extends", "false",
            "finally", "for", "function", "if", "implements", "import", "in",
            "instanceof", "interface", "let", "new", "null", "package", "private",
            "protected", "public", "return", "static", "super", "switch", "this",
            "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield");

    /** キーの出力形。識別子として妥当かつ予約語でなければ裸、それ以外は二重引用符。 */
    public static String key(String k) {
        if (IDENTIFIER.matcher(k).matches() && !RESERVED.contains(k)) {
            return k;
        }
        return quote(k);
    }

    /** 文字列リテラル。二重引用符 + §2.5 のエスケープ。 */
    public static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') {
                sb.append("\\\"");
            } else if (c == '\\') {
                sb.append("\\\\");
            } else if (c == '\n') {
                sb.append("\\n");
            } else if (c == '\r') {
                sb.append("\\r");
            } else if (c == '\t') {
                sb.append("\\t");
            } else if (c == LINE_SEPARATOR) {
                sb.append("\\u2028");
            } else if (c == PARAGRAPH_SEPARATOR) {
                sb.append("\\u2029");
            } else if (c < 0x20) {
                sb.append(String.format("\\u%04x", (int) c));
            } else {
                sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
