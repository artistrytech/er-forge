package erd.core.model;

import com.fasterxml.jackson.annotation.JsonValue;

import java.util.Locale;

/** 正規化型（java.sql.Types 由来）。表示・比較に使う。ファイル上は小文字。 */
public enum LogicalType {
    STRING, INT, FLOAT, DECIMAL, BOOL, DATE, TIME, DATETIME,
    JSON, UUID, BINARY, ENUM, ARRAY, OTHER;

    @JsonValue
    public String jsonName() {
        return name().toLowerCase(Locale.ROOT);
    }

    /** 不明な値は OTHER にフォールバックする（読み込み時検証 V-2）。 */
    public static LogicalType fromJson(String value) {
        if (value == null) return OTHER;
        try {
            return valueOf(value.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return OTHER;
        }
    }

    public static boolean isKnown(String value) {
        if (value == null) return false;
        try {
            valueOf(value.toUpperCase(Locale.ROOT));
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
