package erd.core.diff;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * テーブルのパターンリスト（K-15 詳細設計 §2.4）。
 *
 * <p>3つの記法をこの順で判定する。
 * <ul>
 *   <li>前後を {@code /} で囲む → 正規表現（{@code /^staging\..*_bak$/}）</li>
 *   <li>{@code *} / {@code ?} を含む → glob（{@code public.tmp_*}）</li>
 *   <li>それ以外 → 完全一致（{@code public.flyway_schema_history}）</li>
 * </ul>
 *
 * <p>不正な正規表現は読み込み時に警告として記録し、そのエントリは評価から外す
 * （黙って全マッチさせない。T-11b）。
 */
public final class PatternList {

    /** マッチしたエントリ（原文）を返せるようにパターンと原文を組で保持する。 */
    private record Entry(String source, Pattern regex, String exact) {
        boolean matches(String tableId) {
            return regex != null ? regex.matcher(tableId).matches() : exact.equals(tableId);
        }
    }

    private final List<Entry> entries;
    private final List<String> warnings;

    private PatternList(List<Entry> entries, List<String> warnings) {
        this.entries = entries;
        this.warnings = warnings;
    }

    public static final PatternList EMPTY = new PatternList(List.of(), List.of());

    public static PatternList of(List<String> patterns) {
        if (patterns == null || patterns.isEmpty()) return EMPTY;
        List<Entry> entries = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        for (String raw : patterns) {
            if (raw == null) continue;
            String p = raw.trim();
            if (p.isEmpty()) continue;
            if (p.length() >= 2 && p.startsWith("/") && p.endsWith("/")) {
                String body = p.substring(1, p.length() - 1);
                try {
                    entries.add(new Entry(p, Pattern.compile(body), null));
                } catch (PatternSyntaxException e) {
                    warnings.add("Ignoring invalid regular expression: " + p + " (" + e.getDescription() + ")");
                }
            } else if (p.indexOf('*') >= 0 || p.indexOf('?') >= 0) {
                entries.add(new Entry(p, Pattern.compile(globToRegex(p)), null));
            } else {
                entries.add(new Entry(p, null, p));
            }
        }
        return new PatternList(List.copyOf(entries), List.copyOf(warnings));
    }

    public boolean isEmpty() {
        return entries.isEmpty();
    }

    public boolean matches(String tableId) {
        return matchedBy(tableId) != null;
    }

    /** 最初にマッチしたパターンの原文。マッチしなければ null（プレビューの「無視 (N)」に表示する）。 */
    public String matchedBy(String tableId) {
        for (Entry e : entries) {
            if (e.matches(tableId)) return e.source();
        }
        return null;
    }

    /** 不正な正規表現の警告（起動時・プレビュー時に GUI へ出す）。 */
    public List<String> warnings() {
        return warnings;
    }

    /** glob（{@code *} = 0文字以上、{@code ?} = 1文字）→ 正規表現。他の文字はすべてリテラル。 */
    private static String globToRegex(String glob) {
        StringBuilder sb = new StringBuilder();
        StringBuilder literal = new StringBuilder();
        for (int i = 0; i < glob.length(); i++) {
            char c = glob.charAt(i);
            if (c == '*' || c == '?') {
                if (literal.length() > 0) {
                    sb.append(Pattern.quote(literal.toString()));
                    literal.setLength(0);
                }
                sb.append(c == '*' ? ".*" : ".");
            } else {
                literal.append(c);
            }
        }
        if (literal.length() > 0) {
            sb.append(Pattern.quote(literal.toString()));
        }
        return sb.toString();
    }
}
