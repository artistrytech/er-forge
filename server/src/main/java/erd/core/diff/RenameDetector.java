package erd.core.diff;

import erd.core.model.Column;
import erd.core.model.ForeignKey;
import erd.core.model.TableSchema;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * リネーム検出（K-09 詳細設計 §4.2 / §4.3）。
 *
 * <p>削除候補と追加候補の間で 1:1 マッチングを推定する。ステップ1でカラム構成シグネチャの
 * 完全一致を「確度: 高」として拾い、残りをスコアリングする。マッチングはスコア降順の貪欲法で
 * 確定させる（1つの削除候補が2つの追加候補に割り当たることを防ぐ）。
 *
 * <p>閾値: テーブル 0.60 / カラム 0.70（カラムは同型のものが多く誤検出しやすいため上げる）。
 */
public final class RenameDetector {

    private static final double TABLE_THRESHOLD = 0.60;
    private static final double TABLE_HIGH = 0.80;
    private static final double COLUMN_THRESHOLD = 0.70;
    private static final double COLUMN_HIGH = 0.85;
    private static final double AMBIGUOUS_DELTA = 0.05;

    /** スコア付きのペア候補（内部）。 */
    private record Scored(String from, String to, double score, String reason) {}

    // ---------------------------------------------------------------- テーブル

    /**
     * @param removed 既存側にあり DB から消えたテーブル（ID → schema）
     * @param added   DB にあり既存側に無いテーブル（ID → schema）
     */
    public List<RenameCandidate> detectTables(Map<String, TableSchema> removed,
                                              Map<String, TableSchema> added) {
        List<Scored> scores = new ArrayList<>();
        for (Map.Entry<String, TableSchema> d : removed.entrySet()) {
            for (Map.Entry<String, TableSchema> a : added.entrySet()) {
                if (signature(d.getValue()).equals(signature(a.getValue()))) {
                    scores.add(new Scored(d.getKey(), a.getKey(), 1.0, "COLUMNS_IDENTICAL"));
                } else {
                    double s = tableScore(d.getValue(), a.getValue());
                    if (s >= TABLE_THRESHOLD) {
                        scores.add(new Scored(d.getKey(), a.getKey(), s, "SCORE"));
                    }
                }
            }
        }
        return greedy(scores, TABLE_HIGH, (sc, alts) -> new RenameCandidate(
                RenameCandidate.tableId(sc.from(), sc.to()), "table", null,
                sc.from(), sc.to(),
                sc.score() >= TABLE_HIGH ? "high" : "medium",
                round(sc.score()), sc.reason(), alts, null));
    }

    /** カラム構成シグネチャ（名前 + 正規化型の列）。完全一致はリネーム以外に実際上ありえない。 */
    static String signature(TableSchema t) {
        StringBuilder sb = new StringBuilder();
        for (Column c : t.columns()) {
            sb.append(c.name()).append(':').append(c.logicalType().jsonName()).append('\n');
        }
        return sb.toString();
    }

    private static double tableScore(TableSchema a, TableSchema b) {
        Set<String> an = names(a.columns());
        Set<String> bn = names(b.columns());
        double jaccard = jaccard(an, bn);

        List<String> at = a.columns().stream().map(c -> c.logicalType().jsonName()).toList();
        List<String> bt = b.columns().stream().map(c -> c.logicalType().jsonName()).toList();
        double typeSeq = at.isEmpty() && bt.isEmpty() ? 1.0
                : (double) lcs(at, bt) / Math.max(1, Math.max(at.size(), bt.size()));

        double pk;
        if (a.primaryKey().equals(b.primaryKey())) {
            pk = 1.0;
        } else if (a.primaryKey().size() == b.primaryKey().size() && !a.primaryKey().isEmpty()) {
            pk = 0.5;
        } else {
            pk = 0.0;
        }

        Set<String> ar = a.foreignKeys().stream().map(f -> f.ref().table())
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
        Set<String> br = b.foreignKeys().stream().map(ForeignKey::ref).map(r -> r.table())
                .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
        // どちらも FK を持たない場合は「一致」ではなく「証拠なし」として中立に扱う。
        // 1.0 を与えると、FK を持たない無関係な小テーブル同士が閾値を超えて誤検出される
        double refs = ar.isEmpty() && br.isEmpty() ? 0.5 : jaccard(ar, br);

        double name = nameSimilarity(a.name(), b.name());

        return 0.45 * jaccard + 0.25 * typeSeq + 0.15 * pk + 0.10 * refs + 0.05 * name;
    }

    // ------------------------------------------------------------------ カラム

    /**
     * 同一テーブル内の削除カラムと追加カラムの間でリネームを推定する（§4.3）。
     * これがないと、カラム1つのリネームで meta.columns.&lt;name&gt; の論理名・注記が消える。
     */
    public List<RenameCandidate> detectColumns(String tableId, List<Column> removed, List<Column> added,
                                               List<Column> oldAll, List<Column> newAll) {
        if (removed.isEmpty() || added.isEmpty()) return List.of();

        // 削除1件・追加1件かつ型が一致 → 確度: 高（§4.3）
        if (removed.size() == 1 && added.size() == 1
                && removed.get(0).logicalType() == added.get(0).logicalType()) {
            Column from = removed.get(0);
            Column to = added.get(0);
            return List.of(new RenameCandidate(
                    RenameCandidate.tableId(tableId + "." + from.name(), tableId + "." + to.name()),
                    "column", tableId, from.name(), to.name(), "high", 1.0,
                    "SINGLE_PAIR_SAME_TYPE", List.of(), null));
        }

        List<Scored> scores = new ArrayList<>();
        for (Column d : removed) {
            for (Column a : added) {
                double s = columnScore(d, a, oldAll, newAll);
                if (s >= COLUMN_THRESHOLD) {
                    scores.add(new Scored(d.name(), a.name(), s, "SCORE"));
                }
            }
        }
        return greedy(scores, COLUMN_HIGH, (sc, alts) -> new RenameCandidate(
                RenameCandidate.tableId(tableId + "." + sc.from(), tableId + "." + sc.to()),
                "column", tableId, sc.from(), sc.to(),
                sc.score() >= COLUMN_HIGH ? "high" : "medium",
                round(sc.score()), sc.reason(), alts, null));
    }

    private static double columnScore(Column a, Column b, List<Column> oldAll, List<Column> newAll) {
        double type = a.logicalType() == b.logicalType() ? 1.0 : 0.0;
        int ia = indexOf(oldAll, a.name());
        int ib = indexOf(newAll, b.name());
        int delta = Math.abs(ia - ib);
        double position = delta == 0 ? 1.0 : delta == 1 ? 0.7 : delta <= 3 ? 0.3 : 0.0;
        double attrs = 0.0;
        if (a.nullable() == b.nullable()) attrs += 0.4;
        if (java.util.Objects.equals(Normalize.defaultValue(a.defaultValue()),
                Normalize.defaultValue(b.defaultValue()))) attrs += 0.3;
        if (a.autoIncrement() == b.autoIncrement()) attrs += 0.3;
        double name = nameSimilarity(a.name(), b.name());
        return 0.40 * type + 0.25 * position + 0.20 * attrs + 0.15 * name;
    }

    // -------------------------------------------------------------------- 共通

    private interface Builder {
        RenameCandidate build(Scored s, List<String> alternatives);
    }

    /**
     * スコア降順の貪欲法で 1:1 に確定させる。上位2件のスコア差が 0.05 未満なら「曖昧」とし、
     * 他候補を alternatives に載せてユーザーに選ばせる（自動で片方に決めない。§4.2）。
     */
    private static List<RenameCandidate> greedy(List<Scored> scores, double highThreshold,
                                                Builder builder) {
        scores.sort(Comparator.comparingDouble(Scored::score).reversed()
                .thenComparing(Scored::from).thenComparing(Scored::to));
        Set<String> usedFrom = new HashSet<>();
        Set<String> usedTo = new HashSet<>();
        List<RenameCandidate> out = new ArrayList<>();
        for (Scored s : scores) {
            if (usedFrom.contains(s.from()) || usedTo.contains(s.to())) continue;
            List<String> alternatives = new ArrayList<>();
            for (Scored other : scores) {
                if (other == s || !other.from().equals(s.from())) continue;
                if (usedTo.contains(other.to())) continue;
                if (s.score() - other.score() < AMBIGUOUS_DELTA) {
                    alternatives.add(other.to());
                }
            }
            usedFrom.add(s.from());
            usedTo.add(s.to());
            out.add(builder.build(s, alternatives));
        }
        return out;
    }

    private static Set<String> names(List<Column> columns) {
        Set<String> s = new LinkedHashSet<>();
        for (Column c : columns) {
            s.add(c.name());
        }
        return s;
    }

    private static double jaccard(Set<String> a, Set<String> b) {
        if (a.isEmpty() && b.isEmpty()) return 1.0;
        Set<String> union = new HashSet<>(a);
        union.addAll(b);
        Set<String> inter = new HashSet<>(a);
        inter.retainAll(b);
        return union.isEmpty() ? 0.0 : (double) inter.size() / union.size();
    }

    /** 順序を保った列の最長共通部分列。 */
    private static int lcs(List<String> a, List<String> b) {
        int[][] dp = new int[a.size() + 1][b.size() + 1];
        for (int i = 1; i <= a.size(); i++) {
            for (int j = 1; j <= b.size(); j++) {
                dp[i][j] = a.get(i - 1).equals(b.get(j - 1))
                        ? dp[i - 1][j - 1] + 1
                        : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
        return dp[a.size()][b.size()];
    }

    /** 正規化編集距離（user → users のような語尾変化を拾う）。 */
    static double nameSimilarity(String a, String b) {
        if (a.equals(b)) return 1.0;
        int max = Math.max(a.length(), b.length());
        if (max == 0) return 1.0;
        return 1.0 - (double) levenshtein(a, b) / max;
    }

    private static int levenshtein(String a, String b) {
        int[] prev = new int[b.length() + 1];
        int[] cur = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) {
            prev[j] = j;
        }
        for (int i = 1; i <= a.length(); i++) {
            cur[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            int[] tmp = prev;
            prev = cur;
            cur = tmp;
        }
        return prev[b.length()];
    }

    private static int indexOf(List<Column> columns, String name) {
        for (int i = 0; i < columns.size(); i++) {
            if (columns.get(i).name().equals(name)) return i;
        }
        return -1;
    }

    private static double round(double v) {
        return Math.round(v * 100) / 100.0;
    }
}
