package erd.core.index;

import java.util.List;

/**
 * data/index.js のモデル（派生ファイル。schema/** + diagrams/** からサーバーが必ず再生成する）。
 * ER図はこのファイルだけでノードとエッジを描く。
 */
public record IndexModel(List<TableEntry> tables, List<RelationEntry> relations) {

    /** テーブルの軽量サマリ。displayName は meta.displayName の生の値（未設定なら null = 省略）。 */
    public record TableEntry(
            String id,
            String name,
            String schema,
            String displayName,
            int columns,
            boolean pk,
            List<String> tags,
            List<String> diagrams
    ) {}

    /**
     * エッジ。id = <参照元テーブルID>#<種別>:<制約名>（種別: fk = 物理 / lfk = 論理外部制約）。
     * cardinality は解決後の値のみ（ビューアは導出ロジックを持たない）。
     * explicit は人が meta.relations で明示設定した項目名（"parent" / "child"）。
     * dangling は参照先テーブルが存在しないとき true。
     */
    public record RelationEntry(
            String id,
            String kind,          // "physical" / "logical"
            String from,
            String to,
            List<List<String>> columns,   // [[参照元カラム, 参照先カラム], ...]
            Cardinality cardinality,
            List<String> explicit,
            boolean dangling
    ) {}

    public record Cardinality(String parent, String child) {}
}
