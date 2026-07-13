package erd.core.diff;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 差分プラン（K-08 / 詳細設計 §2.1）。プレビューと適用の両方がこの1つの計算結果を使う。
 *
 * <p>プランは<b>リネーム決定に依存する</b>（承認すれば renamed 1項目、却下すれば削除 + 追加の
 * 2項目になる）。したがって、決定が変わるたびにサーバーで再計算し、UI に差分ロジックを
 * 二重実装しない。適用時も同じ計算を通してから selection を突き合わせる。
 */
public record DiffPlan(
        Stats stats,
        List<DiffItem> items,
        List<RenameCandidate> renameCandidates,
        List<Guard> guards,
        List<Ignored> ignored,
        List<String> outOfScope,
        List<String> warnings
) {
    public record Stats(int added, int removed, int modified, int renamed, int unchanged,
                        int outOfScope, int ignored) {}

    /** 危険な差分に対するガード（§8.5）。適用には confirmed が必要になる。 */
    public record Guard(String code, String severity, String message) {}

    /** 無視リスト（K-15）にマッチしたテーブル。件数のみ表示し、どのパターンで無視されたかを示す。 */
    public record Ignored(String tableId, String matchedBy, boolean existsInDb) {}

    public DiffPlan {
        items = List.copyOf(items);
        renameCandidates = List.copyOf(renameCandidates);
        guards = List.copyOf(guards);
        ignored = List.copyOf(ignored);
        outOfScope = List.copyOf(outOfScope);
        warnings = List.copyOf(warnings);
    }

    /** id → 項目（選択の検証・適用で引く）。 */
    public Map<String, DiffItem> index() {
        Map<String, DiffItem> out = new LinkedHashMap<>();
        for (DiffItem item : items) {
            item.flattenInto(out);
        }
        return out;
    }

    public boolean hasBlockingGuard() {
        return guards.stream().anyMatch(g -> "error".equals(g.severity()) || "warn".equals(g.severity()));
    }
}
