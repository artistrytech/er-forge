package erd.core.diff;

/**
 * リネーム候補に対するユーザーの判断（K-09 §4.4）。
 *
 * <p>既定は「未決定」であり、勝手に承認済みにしない。未決定が残っている状態での適用は
 * サーバーが 400 で拒否する（UI 側でも先に確認する）。
 *
 * @param id       候補ID（{@code rename:<from>-><to>}）。ツールが見逃したリネームを人が
 *                 指定する場合も、この形式で from を表現する
 * @param decision accept | reject | correct
 * @param to       correct のときの対応先（テーブルID / カラム名）
 */
public record RenameDecision(String id, String decision, String to) {

    public boolean accepted() {
        return "accept".equals(decision) || "correct".equals(decision);
    }

    public boolean rejected() {
        return "reject".equals(decision);
    }

    /** 候補ID から from を取り出す（{@code rename:A->B} → {@code A}）。 */
    public String from() {
        int arrow = id.indexOf("->");
        return arrow < 0 ? id : id.substring("rename:".length(), arrow);
    }

    /** 承認後の対応先。correct なら to、accept なら候補ID の右辺。 */
    public String target() {
        if (to != null && !to.isEmpty()) return to;
        int arrow = id.indexOf("->");
        return arrow < 0 ? null : id.substring(arrow + 2);
    }
}
