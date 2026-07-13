package erd.core.diff;

import erd.core.model.Column;
import erd.core.model.ForeignKey;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 誤差分（false diff）を出さないための正規化（K-08〜K-13 詳細設計 §2.3）。
 *
 * <p><b>同じ DB を2回内省したら差分ゼロ</b>でなければならない（T-1）。ドライバやバージョンの
 * 表記ゆれで毎回差分が出ると、プレビューが信用されなくなり誰も読まなくなる。
 *
 * <p>比較に使う正規化と、ファイルに保存する値は別である（{@code type} は DB が返した原文を保存し、
 * 比較時にのみ小文字化する）。ただしデフォルト値のキャスト除去のように、原文のままでは
 * 別 DB / 別バージョンで揺れる値は保存時にも正規化する（{@link #defaultValue}）。
 */
public final class Normalize {

    private static final Pattern CAST = Pattern.compile("::[a-zA-Z_][\\w ]*(\\([^)]*\\))?$");

    /** 型名: 前後空白の除去、{@code VARCHAR (255)} → {@code varchar(255)}。比較専用。 */
    public static String type(String type) {
        if (type == null) return "";
        return type.trim().toLowerCase(Locale.ROOT).replaceAll("\\s*\\(\\s*", "(")
                .replaceAll("\\s*\\)", ")").replaceAll("\\s*,\\s*", ",");
    }

    /**
     * デフォルト値: PostgreSQL のキャスト（{@code 'foo'::text}）を落とし、関数名を小文字化する。
     * 保存値にも適用する（キャスト表記はドライバ・バージョンで揺れるため）。
     */
    public static String defaultValue(String def) {
        if (def == null) return null;
        String d = def.trim();
        if (d.isEmpty()) return null;
        String prev;
        do {
            prev = d;
            d = CAST.matcher(d).replaceFirst("").trim();
        } while (!d.equals(prev));
        // 関数呼び出し（now() / CURRENT_TIMESTAMP）は小文字に寄せる。文字列リテラルは触らない
        if (!d.startsWith("'")) {
            String lower = d.toLowerCase(Locale.ROOT);
            if (lower.equals("current_timestamp") || lower.endsWith("()")) {
                d = lower;
            }
        }
        return d.isEmpty() ? null : d;
    }

    /** コメント: 改行を LF に統一し、末尾空白を除去。空文字と null は同一視する。 */
    public static String comment(String comment) {
        if (comment == null) return null;
        String c = comment.replace("\r\n", "\n").replace('\r', '\n').stripTrailing();
        return c.isEmpty() ? null : c;
    }

    /** カラムの比較キー（machine-owned のみ。§2.2）。 */
    public static String columnKey(Column c) {
        return String.join("",
                type(c.type()),
                c.logicalType().jsonName(),
                String.valueOf(c.nullable()),
                String.valueOf(defaultValue(c.defaultValue())),
                String.valueOf(c.autoIncrement()),
                String.valueOf(c.generated()),
                String.valueOf(comment(c.comment())),
                String.valueOf(c.unknown()));
    }

    /** 外部キーの比較キー（名前は別で比較する）。 */
    public static String fkKey(ForeignKey fk) {
        return fk.columns() + "->" + fk.ref().table() + fk.ref().columns()
                + "|" + fk.onDelete().toLowerCase(Locale.ROOT)
                + "|" + fk.onUpdate().toLowerCase(Locale.ROOT);
    }

    /** 表示用の型 + NULL可（差分ツリーの before / after に出す1行）。 */
    public static String columnSummary(Column c) {
        StringBuilder sb = new StringBuilder(c.type());
        sb.append(c.nullable() ? " NULL" : " NOT NULL");
        if (c.defaultValue() != null) sb.append(" DEFAULT ").append(c.defaultValue());
        if (c.autoIncrement()) sb.append(" AUTO_INCREMENT");
        return sb.toString();
    }

    private Normalize() { }
}
