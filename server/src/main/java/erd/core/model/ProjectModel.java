package erd.core.model;

import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * プロジェクト全体のモデル。index.js は派生ファイルであり、ここには含まれない
 * （書き出し時に必ず再生成する）。
 */
public record ProjectModel(
        Manifest manifest,
        ProjectConfig config,
        Dictionary dictionary,
        List<Table> tables,
        List<DiagramPage> diagrams
) {
    public ProjectModel {
        tables = List.copyOf(tables);
        diagrams = List.copyOf(diagrams);
    }

    public Optional<Table> table(String id) {
        return tables.stream().filter(t -> t.id().equals(id)).findFirst();
    }

    /** 書き出し順・manifest 生成用: テーブルは ID 昇順、ページは order → id 順。 */
    public List<Table> tablesSorted() {
        return tables.stream().sorted(Comparator.comparing(Table::id)).toList();
    }

    public List<DiagramPage> diagramsSorted() {
        return diagrams.stream()
                .sorted(Comparator.comparingInt(DiagramPage::order).thenComparing(DiagramPage::id))
                .toList();
    }
}
