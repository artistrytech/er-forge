package erd.core.apply;

import erd.core.model.ProjectModel;

import java.util.List;

/**
 * 適用の結果（K-11 詳細設計 §6.5）。
 *
 * @param model             適用後のモデル（まだ書き込んでいない。書き出しは呼び出し側）
 * @param applied           適用件数
 * @param skipped           選択されなかった項目ID（「N 件の差分を適用せずに残します」。§5.3）
 * @param seededTables      論理名を補完したテーブル数（K-14）
 * @param seededColumns     論理名を補完したカラム数（K-14）
 * @param unplacedTables    どのページにも配置されていないテーブル（K-12。今回の新規を含む）
 * @param orphanNodes       参照先スキーマを失ったノード（K-13）
 * @param warnings          適用したが注意が必要なこと（参照先を失った論理外部制約など。V-3）
 */
public record ApplyResult(
        ProjectModel model,
        Counts applied,
        List<String> skipped,
        int seededTables,
        int seededColumns,
        List<String> unplacedTables,
        List<Orphan> orphanNodes,
        List<Warning> warnings
) {
    public record Counts(int added, int removed, int modified, int renamed) {}

    public record Orphan(String tableId, List<String> diagrams) {
        public Orphan {
            diagrams = List.copyOf(diagrams);
        }
    }

    public record Warning(String code, String message) {}

    public ApplyResult {
        skipped = List.copyOf(skipped);
        unplacedTables = List.copyOf(unplacedTables);
        orphanNodes = List.copyOf(orphanNodes);
        warnings = List.copyOf(warnings);
    }
}
