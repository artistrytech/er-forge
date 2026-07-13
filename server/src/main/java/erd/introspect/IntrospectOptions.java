package erd.introspect;

import erd.core.diff.PatternList;

import java.util.List;

/**
 * 内省の対象範囲（K-06 / §7.5）。
 *
 * <p>{@code namespace} は「1プロジェクト = 1スキーマ」の唯一の指定箇所（§1.2）。
 * {@code include} / {@code exclude} は<b>今回の内省に限った</b>フィルタであり、
 * 既存定義には作用しない（恒久的な除外は config.js の無視リスト = K-15）。
 *
 * <p>パターンはテーブル名（{@code users}）と完全修飾ID（{@code public.users}）の
 * どちらにマッチしても有効とする（利用者がどちらで書いても意図どおりに効く）。
 */
public final class IntrospectOptions {

    private final String namespace;
    private final List<String> include;
    private final List<String> exclude;
    private final PatternList includePatterns;
    private final PatternList excludePatterns;

    public IntrospectOptions(String namespace, List<String> include, List<String> exclude) {
        this.namespace = namespace;
        this.include = include == null ? List.of() : List.copyOf(include);
        this.exclude = exclude == null ? List.of() : List.copyOf(exclude);
        this.includePatterns = PatternList.of(this.include);
        this.excludePatterns = PatternList.of(this.exclude);
    }

    public String namespace() {
        return namespace;
    }

    public List<String> include() {
        return include;
    }

    public List<String> exclude() {
        return exclude;
    }

    public boolean accepts(String ns, String tableName) {
        String id = ns == null || ns.isEmpty() ? tableName : ns + "." + tableName;
        if (!includePatterns.isEmpty()
                && !includePatterns.matches(tableName) && !includePatterns.matches(id)) {
            return false;
        }
        return !excludePatterns.matches(tableName) && !excludePatterns.matches(id);
    }

    /** 不正な正規表現の警告（フィルタ側）。 */
    public List<String> warnings() {
        List<String> w = new java.util.ArrayList<>(includePatterns.warnings());
        w.addAll(excludePatterns.warnings());
        return w;
    }
}
