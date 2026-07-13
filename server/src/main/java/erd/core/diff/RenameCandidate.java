package erd.core.diff;

import java.util.List;

/**
 * リネーム候補（K-09）。テーブル・カラムの両方に使う。
 *
 * <p>リネームを「削除 + 追加」として扱うと meta（論理名・注記・論理制約）と ER図の配置が失われる。
 * これは INV-1 / INV-2 の実質的な破壊であり、検出はそれを防ぐための機構である。
 *
 * <p>{@code id} の形式:
 * <ul>
 *   <li>テーブル: {@code rename:public.user->public.users}</li>
 *   <li>カラム: {@code rename:public.users.mail->public.users.email}</li>
 * </ul>
 */
public record RenameCandidate(
        String id,
        String kind,          // table | column
        String tableId,       // column のとき、対象テーブル（適用後のID）
        String from,
        String to,
        String confidence,    // high | medium
        double score,
        String reason,
        List<String> alternatives,   // 曖昧な場合の他候補（to の値）
        Impact impact
) {
    /** 承認したときに波及する範囲（UI が「何が変わるか」を示すために使う）。 */
    public record Impact(List<String> diagrams, List<String> referencingTables, boolean hasMeta) {
        public Impact {
            diagrams = diagrams == null ? List.of() : List.copyOf(diagrams);
            referencingTables = referencingTables == null ? List.of() : List.copyOf(referencingTables);
        }
    }

    public RenameCandidate {
        alternatives = alternatives == null ? List.of() : List.copyOf(alternatives);
    }

    public static String tableId(String from, String to) {
        return "rename:" + from + "->" + to;
    }
}
