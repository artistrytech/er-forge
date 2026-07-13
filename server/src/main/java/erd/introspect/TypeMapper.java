package erd.introspect;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.BooleanNode;
import com.fasterxml.jackson.databind.node.TextNode;
import erd.core.model.LogicalType;

import java.sql.Types;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 型の二重保持（§5.7 / §7.4）。
 *
 * <ul>
 *   <li>{@code type}: JDBC の {@code TYPE_NAME} に基づく DB 生の型文字列（忠実性）</li>
 *   <li>{@code logicalType}: {@code java.sql.Types}（{@code DATA_TYPE}）に基づく正規化型</li>
 * </ul>
 *
 * <p>DB 差異（MySQL の unsigned / tinyint(1)、PostgreSQL の配列）は層1（JDBC 標準）の
 * 範囲で吸収できるものだけをここで扱い、{@code dialect} に退避する。CHECK 制約・ENUM 値の
 * ような標準 API に存在しない情報は {@link DialectEnhancer}（層2）の担当である。
 */
public final class TypeMapper {

    /** カラム1件の型情報（type / logicalType / dialect への退避分）。 */
    public record ColumnType(String type, LogicalType logicalType, Map<String, JsonNode> dialect) {}

    public static ColumnType map(String typeName, int dataType, int size, int decimalDigits) {
        String raw = typeName == null ? "" : typeName.trim();
        Map<String, JsonNode> dialect = new LinkedHashMap<>();
        String lower = raw.toLowerCase(Locale.ROOT);

        // MySQL: TYPE_NAME が "INT UNSIGNED" を返す。フラグを dialect へ退避する（§7.4）
        if (lower.endsWith(" unsigned")) {
            dialect.put("unsigned", BooleanNode.TRUE);
        }
        // PostgreSQL: 配列型は TYPE_NAME が "_int4" のように "_" 接頭辞になる（§7.4）
        if (lower.startsWith("_") && lower.length() > 1) {
            dialect.put("elementType", new TextNode(lower.substring(1)));
            return new ColumnType(lower, LogicalType.ARRAY, dialect);
        }

        String type = withPrecision(lower, dataType, size, decimalDigits);
        return new ColumnType(type, logicalType(lower, type, dataType), dialect);
    }

    /** TYPE_NAME に桁が含まれない場合に COLUMN_SIZE / DECIMAL_DIGITS から補う。 */
    private static String withPrecision(String lower, int dataType, int size, int decimalDigits) {
        if (lower.indexOf('(') >= 0 || size <= 0) return lower;
        return switch (dataType) {
            case Types.CHAR, Types.VARCHAR, Types.NCHAR, Types.NVARCHAR,
                 Types.BINARY, Types.VARBINARY -> lower + "(" + size + ")";
            case Types.DECIMAL, Types.NUMERIC ->
                    decimalDigits > 0 ? lower + "(" + size + "," + decimalDigits + ")"
                                      : lower + "(" + size + ")";
            default -> lower;
        };
    }

    private static LogicalType logicalType(String lower, String type, int dataType) {
        // MySQL の tinyint(1) は bool として正規化する（type は原文を保持。§7.4）
        if (type.startsWith("tinyint(1)") || lower.equals("bool") || lower.equals("boolean")) {
            return LogicalType.BOOL;
        }
        return switch (dataType) {
            case Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR,
                 Types.NCHAR, Types.NVARCHAR, Types.LONGNVARCHAR, Types.CLOB, Types.NCLOB ->
                    named(lower, LogicalType.STRING);
            case Types.TINYINT, Types.SMALLINT, Types.INTEGER, Types.BIGINT -> LogicalType.INT;
            case Types.REAL, Types.FLOAT, Types.DOUBLE -> LogicalType.FLOAT;
            case Types.DECIMAL, Types.NUMERIC -> LogicalType.DECIMAL;
            case Types.BIT, Types.BOOLEAN -> LogicalType.BOOL;
            case Types.DATE -> LogicalType.DATE;
            case Types.TIME, Types.TIME_WITH_TIMEZONE -> LogicalType.TIME;
            case Types.TIMESTAMP, Types.TIMESTAMP_WITH_TIMEZONE -> LogicalType.DATETIME;
            case Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY, Types.BLOB -> LogicalType.BINARY;
            case Types.ARRAY -> LogicalType.ARRAY;
            case Types.OTHER, Types.JAVA_OBJECT, Types.STRUCT, Types.DISTINCT, Types.NULL ->
                    named(lower, LogicalType.OTHER);
            default -> named(lower, LogicalType.OTHER);
        };
    }

    /**
     * DATA_TYPE が OTHER / VARCHAR に丸められる型（PostgreSQL の json・uuid、
     * ドライバによっては enum）を TYPE_NAME から救う。
     */
    private static LogicalType named(String lower, LogicalType fallback) {
        return switch (lower) {
            case "json", "jsonb" -> LogicalType.JSON;
            case "uuid" -> LogicalType.UUID;
            case "enum" -> LogicalType.ENUM;
            default -> fallback;
        };
    }

    private TypeMapper() { }
}
