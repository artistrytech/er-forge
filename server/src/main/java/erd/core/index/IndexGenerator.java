package erd.core.index;

import erd.core.model.Column;
import erd.core.model.DiagramPage;
import erd.core.model.ForeignKey;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalUnique;
import erd.core.model.RelationMeta;
import erd.core.model.Table;
import erd.core.model.UniqueConstraint;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * data/index.js の生成（Phase0 詳細設計 §4）とカーディナリティの解決（§5）。
 *
 * <p>index.js は schema/** + diagrams/** から必ず再生成する派生ファイル。
 * カーディナリティは「物理からの導出値」を既定とし、meta.relations の上書きで解決する。
 * ビューアは導出ロジックを持たない（解決後の値のみを載せる）。
 */
public final class IndexGenerator {

    public IndexModel generate(List<Table> tables, List<DiagramPage> diagrams) {
        Set<String> tableIds = new HashSet<>();
        for (Table t : tables) {
            tableIds.add(t.id());
        }

        // テーブルID → 所属ページID（昇順）
        Map<String, Set<String>> tableDiagrams = new HashMap<>();
        for (DiagramPage page : diagrams) {
            for (String tableId : page.nodes().keySet()) {
                tableDiagrams.computeIfAbsent(tableId, k -> new TreeSet<>()).add(page.id());
            }
        }

        List<IndexModel.TableEntry> tableEntries = new ArrayList<>();
        List<IndexModel.RelationEntry> relationEntries = new ArrayList<>();

        for (Table t : tables) {
            String displayName = t.meta().displayName();
            tableEntries.add(new IndexModel.TableEntry(
                    t.id(),
                    t.schema().name(),
                    t.schema().schema(),
                    displayName == null || displayName.isEmpty() ? null : displayName,
                    t.schema().columns().size(),
                    !t.schema().primaryKey().isEmpty(),
                    t.meta().tags(),
                    List.copyOf(tableDiagrams.getOrDefault(t.id(), Set.of()))));

            for (ForeignKey fk : t.schema().foreignKeys()) {
                relationEntries.add(relation(t, "fk", fk.name(), fk.columns(), fk.ref().table(),
                        fk.ref().columns(), tableIds));
            }
            for (LogicalForeignKey lfk : t.meta().logicalForeignKeys()) {
                relationEntries.add(relation(t, "lfk", lfk.name(), lfk.columns(), lfk.ref().table(),
                        lfk.ref().columns(), tableIds));
            }
        }

        tableEntries.sort(Comparator.comparing(IndexModel.TableEntry::id));
        relationEntries.sort(Comparator.comparing(IndexModel.RelationEntry::id));
        return new IndexModel(tableEntries, relationEntries);
    }

    private IndexModel.RelationEntry relation(Table from, String kindPrefix, String constraintName,
                                              List<String> fromColumns, String toTable,
                                              List<String> toColumns, Set<String> tableIds) {
        String id = from.id() + "#" + kindPrefix + ":" + constraintName;
        String kind = kindPrefix.equals("fk") ? "physical" : "logical";

        List<List<String>> columnPairs = new ArrayList<>();
        for (int i = 0; i < fromColumns.size(); i++) {
            String toCol = i < toColumns.size() ? toColumns.get(i) : "";
            columnPairs.add(List.of(fromColumns.get(i), toCol));
        }

        Resolved resolved = resolveCardinality(from, kindPrefix + ":" + constraintName, fromColumns);
        boolean dangling = !tableIds.contains(toTable);

        return new IndexModel.RelationEntry(id, kind, from.id(), toTable, columnPairs,
                resolved.cardinality, resolved.explicit, dangling);
    }

    private record Resolved(IndexModel.Cardinality cardinality, List<String> explicit) {}

    /**
     * カーディナリティの解決（§5.3）。
     *
     * <pre>
     * physical.parent = すべての FK カラムが NOT NULL ? "1..1" : "0..1"
     * physical.child  = FK カラム集合に一意制約あり   ? "0..1" : "0..N"
     *   （一意制約 = PK / uniques / meta.logicalUniques。カラム集合が完全一致するもの）
     * 上書き = meta.relations[<種別>:<制約名>]
     * </pre>
     */
    private Resolved resolveCardinality(Table table, String relationKey, List<String> fkColumns) {
        boolean allNotNull = true;
        Map<String, Column> byName = new HashMap<>();
        for (Column c : table.schema().columns()) {
            byName.put(c.name(), c);
        }
        for (String name : fkColumns) {
            Column c = byName.get(name);
            if (c == null || c.nullable()) {
                allNotNull = false;
                break;
            }
        }
        String derivedParent = allNotNull ? "1..1" : "0..1";
        String derivedChild = hasUniqueOn(table, fkColumns) ? "0..1" : "0..N";

        RelationMeta override = table.meta().relations().get(relationKey);
        String parent = derivedParent;
        String child = derivedChild;
        List<String> explicit = new ArrayList<>();
        if (override != null) {
            if (override.parent() != null) {
                parent = override.parent();
                explicit.add("parent");
            }
            if (override.child() != null) {
                child = override.child();
                explicit.add("child");
            }
        }
        return new Resolved(new IndexModel.Cardinality(parent, child), explicit);
    }

    /** FK カラム集合と完全一致する一意制約（PK / uniques / 論理一意制約）があるか。 */
    private boolean hasUniqueOn(Table table, List<String> fkColumns) {
        Set<String> target = new HashSet<>(fkColumns);
        if (!table.schema().primaryKey().isEmpty()
                && new HashSet<>(table.schema().primaryKey()).equals(target)) {
            return true;
        }
        for (UniqueConstraint u : table.schema().uniques()) {
            if (new HashSet<>(u.columns()).equals(target)) return true;
        }
        for (var ix : table.schema().indexes()) {
            if (ix.unique() && new HashSet<>(ix.columns()).equals(target)) return true;
        }
        for (LogicalUnique lu : table.meta().logicalUniques()) {
            if (new HashSet<>(lu.columns()).equals(target)) return true;
        }
        return false;
    }
}
