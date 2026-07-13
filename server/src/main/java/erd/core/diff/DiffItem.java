package erd.core.diff;

import java.util.List;

/**
 * 差分ツリーの1項目（K-08〜K-13 詳細設計 §2.1）。
 *
 * <p>{@code id} は決定論的なパス形式（{@code table:public.users/column:email}）。
 * UI の選択状態・適用リクエスト・ログのすべてでこの id を使う。
 *
 * <p>適用可否の判定（§5.2 の依存関係）:
 * <ul>
 *   <li>{@code requires}: この項目を適用するために<b>先に適用が必要</b>な項目（例: FK 追加 →
 *       参照先テーブルの追加）。満たさずに選択されたらサーバーが 400 で拒否する</li>
 *   <li>{@code forcedBy}: いずれかが適用されるとき<b>強制的に一緒に適用される</b>（例: カラム削除 →
 *       そのカラムを含む制約の削除）。UI ではチェックを外せない（{@code selectable = false}）</li>
 * </ul>
 *
 * <p>{@code renamedFrom} は change = renamed のときの旧識別子（テーブルID / カラム名）。
 * 適用側が表示文字列をパースせずにリネームを再現できるようにするため、構造化して持つ。
 */
public record DiffItem(
        String id,
        String kind,        // table | column | primaryKey | unique | index | foreignKey | comment | dialect | displayName
        String change,      // added | removed | modified | renamed | unchanged
        String target,
        String renamedFrom,
        String before,
        String after,
        boolean selectable,
        List<String> requires,
        List<String> forcedBy,
        List<Warn> warnings,
        List<DiffItem> children
) {
    /** 失われるものの事前警告（§3.2）。 */
    public record Warn(String code, String message) {}

    public DiffItem {
        requires = requires == null ? List.of() : List.copyOf(requires);
        forcedBy = forcedBy == null ? List.of() : List.copyOf(forcedBy);
        warnings = warnings == null ? List.of() : List.copyOf(warnings);
        children = children == null ? List.of() : List.copyOf(children);
    }

    /** 選択可能・依存なし・子なしの単純な項目。 */
    public static DiffItem of(String id, String kind, String change, String target,
                              String before, String after) {
        return new DiffItem(id, kind, change, target, null, before, after, true,
                List.of(), List.of(), List.of(), List.of());
    }

    public DiffItem with(boolean selectable, List<String> requires, List<String> forcedBy,
                         List<Warn> warnings, List<DiffItem> children) {
        return new DiffItem(id, kind, change, target, renamedFrom, before, after, selectable,
                requires, forcedBy, warnings, children);
    }

    public DiffItem withChildren(List<DiffItem> children) {
        return with(selectable, requires, forcedBy, warnings, children);
    }

    /** 自分自身と全子孫（選択の検証・適用で平坦に引くため）。 */
    public void flattenInto(java.util.Map<String, DiffItem> out) {
        out.put(id, this);
        for (DiffItem c : children) {
            c.flattenInto(out);
        }
    }
}
