package erd.core.diff;

import erd.core.model.Column;
import erd.core.model.DiagramPage;
import erd.core.model.ForeignKey;
import erd.core.model.IndexDef;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalUnique;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableSchema;
import erd.core.model.UniqueConstraint;
import erd.introspect.RawSchema;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 差分計算（K-08 / 詳細設計 §2）。
 *
 * <p>比較するのは machine-owned なキーだけである（INV-1）。{@code meta.*} / {@code diagrams/**} /
 * {@code dictionary.js} は読むが、それは<b>「何が失われるか」の警告</b>（§3.2）と
 * <b>論理名の初期値補完</b>（K-14）のためだけであり、差分の対象にはしない。
 *
 * <p>対象範囲（§2.4）: DB 側・既存定義側の<b>双方</b>から、無視リストにマッチするテーブルと
 * スコープ外のネームスペースを除く。これを間違えると「手動定義テーブルが毎回削除候補として出る」
 * という、日々の運用を摩耗させる問題になる（INV-6）。
 */
public final class SchemaDiff {

    private final RenameDetector renames = new RenameDetector();

    public DiffPlan plan(ProjectModel model, RawSchema raw, PatternList ignore,
                         List<RenameDecision> decisions) {
        String ns = raw.namespace();
        List<String> warnings = new ArrayList<>(raw.warnings());
        warnings.addAll(ignore.warnings());

        // ---- 対象範囲の切り分け（§2.4） ----
        Map<String, TableSchema> dbTables = new LinkedHashMap<>();
        List<DiffPlan.Ignored> ignored = new ArrayList<>();
        for (TableSchema t : raw.tables()) {
            String id = RawSchema.idOf(t);
            String matched = ignore.matchedBy(id);
            if (matched != null) {
                ignored.add(new DiffPlan.Ignored(id, matched, true));
            } else {
                dbTables.put(id, t);
            }
        }
        Map<String, Table> existing = new LinkedHashMap<>();
        List<String> outOfScope = new ArrayList<>();
        for (Table t : model.tablesSorted()) {
            String schema = t.schema().schema() == null ? "" : t.schema().schema();
            String scope = ns == null ? "" : ns;
            if (!schema.equals(scope)) {
                outOfScope.add(t.id());
                continue;
            }
            String matched = ignore.matchedBy(t.id());
            if (matched != null) {
                ignored.add(new DiffPlan.Ignored(t.id(), matched, dbTables.containsKey(t.id())));
                continue;
            }
            existing.put(t.id(), t);
        }
        // 無視リストにマッチする既存定義は DB 側からも比較対象から外す（双方向。INV-6）
        for (DiffPlan.Ignored ig : ignored) {
            dbTables.remove(ig.tableId());
        }

        // ---- リネーム候補の推定（K-09） ----
        Map<String, TableSchema> removedSchemas = new LinkedHashMap<>();
        for (Map.Entry<String, Table> e : existing.entrySet()) {
            if (!dbTables.containsKey(e.getKey())) removedSchemas.put(e.getKey(), e.getValue().schema());
        }
        Map<String, TableSchema> addedSchemas = new LinkedHashMap<>();
        for (Map.Entry<String, TableSchema> e : dbTables.entrySet()) {
            if (!existing.containsKey(e.getKey())) addedSchemas.put(e.getKey(), e.getValue());
        }
        List<RenameCandidate> candidates = detectTableRenames(removedSchemas, addedSchemas);

        // ---- 決定を反映してペアを確定する ----
        Map<String, RenameDecision> byId = new LinkedHashMap<>();
        for (RenameDecision d : decisions) {
            byId.put(d.id(), d);
        }
        Map<String, String> pairs = new LinkedHashMap<>();   // 旧ID → 新ID
        Set<String> pairedTo = new HashSet<>();
        for (RenameCandidate c : candidates) {
            RenameDecision d = byId.get(c.id());
            if (d != null && d.rejected()) continue;
            String to = d != null ? d.target() : c.to();
            if (!addedSchemas.containsKey(to) || pairedTo.contains(to)) continue;
            pairs.put(c.from(), to);
            pairedTo.add(to);
        }
        // ツールが見逃したリネームを人が指定した場合（候補に無い correct 決定。§4.4）
        for (RenameDecision d : decisions) {
            if (!"correct".equals(d.decision()) || !d.id().startsWith("rename:")) continue;
            String from = d.from();
            String to = d.target();
            if (!removedSchemas.containsKey(from) || !addedSchemas.containsKey(to)) continue;
            if (pairs.containsKey(from) || pairedTo.contains(to)) continue;
            pairs.put(from, to);
            pairedTo.add(to);
        }

        // ---- 項目の構築 ----
        List<DiffItem> items = new ArrayList<>();
        List<RenameCandidate> columnCandidates = new ArrayList<>();
        int added = 0;
        int removed = 0;
        int modified = 0;
        int renamed = 0;
        int unchanged = 0;

        Set<String> addedIds = new LinkedHashSet<>();
        for (String id : addedSchemas.keySet()) {
            if (!pairedTo.contains(id)) addedIds.add(id);
        }

        for (Map.Entry<String, TableSchema> e : dbTables.entrySet()) {
            String newId = e.getKey();
            TableSchema neu = e.getValue();
            String oldId = pairs.entrySet().stream()
                    .filter(p -> p.getValue().equals(newId)).map(Map.Entry::getKey)
                    .findFirst().orElse(existing.containsKey(newId) ? newId : null);

            if (oldId == null) {
                items.add(addedTable(newId, neu, model, addedIds));
                added++;
                continue;
            }
            Table old = existing.get(oldId);
            boolean isRename = !oldId.equals(newId);
            TableChange change = compare(old, neu, newId, byId, model, addedIds, columnCandidates);
            if (isRename) {
                items.add(new DiffItem("table:" + newId, "table", "renamed", newId,
                        oldId, oldId, newId, false, List.of(), List.of(),
                        renameWarnings(old, model), change.children()));
                renamed++;
            } else if (!change.children().isEmpty()) {
                items.add(new DiffItem("table:" + newId, "table", "modified", newId,
                        null, null, null, false, List.of(), List.of(), List.of(), change.children()));
                modified++;
            } else {
                unchanged++;
            }
        }

        for (Map.Entry<String, Table> e : existing.entrySet()) {
            if (dbTables.containsKey(e.getKey()) || pairs.containsKey(e.getKey())) continue;
            items.add(removedTable(e.getValue(), model));
            removed++;
        }

        // FK 削除の強制（R-4）: 削除されるテーブルを参照している FK の削除は外せない
        Set<String> removedTableIds = new LinkedHashSet<>();
        for (DiffItem item : items) {
            if ("table".equals(item.kind()) && "removed".equals(item.change())) {
                removedTableIds.add(item.target());
            }
        }
        items = items.stream().map(item -> forceFkRemovals(item, removedTableIds)).toList();

        items = new ArrayList<>(items);
        items.sort(Comparator.comparing((DiffItem i) -> order(i.change())).thenComparing(DiffItem::target));

        candidates.addAll(columnCandidates);
        DiffPlan.Stats stats = new DiffPlan.Stats(added, removed, modified, renamed, unchanged,
                outOfScope.size(), ignored.size());
        List<DiffPlan.Guard> guards = guards(stats, existing.size(), raw, model, items);
        return new DiffPlan(stats, items, candidates, guards, ignored, outOfScope, warnings);
    }

    /**
     * テーブルのリネーム候補（K-17）。<b>種別ごとに分けて推定する。</b>
     *
     * <p>{@link RenameDetector} はカラム構成の類似度だけで判定するため、ビューは元テーブルと
     * 列構成が一致することが多く、{@code users}（TABLE）と {@code v_users}（VIEW）が
     * 「確度: 高」のリネーム候補として提示されてしまう。種別が違うものはリネームではなく
     * 「削除 + 追加」であり、候補にしてはならない。
     */
    private List<RenameCandidate> detectTableRenames(Map<String, TableSchema> removed,
                                                     Map<String, TableSchema> added) {
        Set<String> kinds = new LinkedHashSet<>();
        removed.values().forEach(s -> kinds.add(kindKey(s)));
        added.values().forEach(s -> kinds.add(kindKey(s)));

        List<RenameCandidate> out = new ArrayList<>();
        for (String kind : kinds) {
            Map<String, TableSchema> r = byKind(removed, kind);
            Map<String, TableSchema> a = byKind(added, kind);
            if (r.isEmpty() || a.isEmpty()) continue;
            out.addAll(renames.detectTables(r, a));
        }
        return out;
    }

    private static String kindKey(TableSchema s) {
        return s.kind().toUpperCase(java.util.Locale.ROOT);
    }

    private static Map<String, TableSchema> byKind(Map<String, TableSchema> src, String kind) {
        Map<String, TableSchema> out = new LinkedHashMap<>();
        src.forEach((id, s) -> {
            if (kindKey(s).equals(kind)) out.put(id, s);
        });
        return out;
    }

    private static int order(String change) {
        return switch (change) {
            case "added" -> 0;
            case "renamed" -> 1;
            case "modified" -> 2;
            default -> 3;
        };
    }

    // ------------------------------------------------------------- テーブル追加

    private DiffItem addedTable(String id, TableSchema neu, ProjectModel model, Set<String> addedIds) {
        // 追加テーブルの配下（カラム・制約）は個別に外せない（テーブル1件が適用の単位。R-1）
        List<DiffItem> children = new ArrayList<>();
        for (Column c : neu.columns()) {
            List<DiffItem> seeds = new ArrayList<>();
            String seed = seedName(c.comment());
            if (seed != null && model.dictionary().displayNameOf(c.name()) == null) {
                seeds.add(new DiffItem("table:" + id + "/column:" + c.name() + "/displayName",
                        "displayName", "added", c.name(), null, null, seed,
                        true, List.of(), List.of(), List.of(), List.of()));
            }
            children.add(new DiffItem("table:" + id + "/column:" + c.name(), "column", "added",
                    c.name(), null, null, Normalize.columnSummary(c),
                    false, List.of(), List.of(), List.of(), seeds));
        }
        for (ForeignKey fk : neu.foreignKeys()) {
            children.add(new DiffItem("table:" + id + "/fk:" + fk.name(), "foreignKey", "added",
                    fk.name(), null, null, fkSummary(fk), false,
                    addedIds.contains(fk.ref().table()) ? List.of("table:" + fk.ref().table()) : List.of(),
                    List.of(), List.of(), List.of()));
        }
        String tableSeed = seedName(neu.comment());
        if (tableSeed != null) {
            children.add(new DiffItem("table:" + id + "/displayName", "displayName", "added",
                    neu.name(), null, null, tableSeed, true, List.of(), List.of(), List.of(), List.of()));
        }
        return new DiffItem("table:" + id, "table", "added", id, null, null,
                objectSummary(neu), true, List.of(), List.of(), List.of(), children);
    }

    // ------------------------------------------------------------- テーブル削除

    private DiffItem removedTable(Table old, ProjectModel model) {
        List<DiffItem.Warn> warns = new ArrayList<>();
        List<String> pages = pagesWith(model, old.id());
        if (!pages.isEmpty()) {
            warns.add(new DiffItem.Warn("ORPHAN_NODES", String.join(", ", pages)));
        }
        if (!old.meta().isEmpty()) {
            warns.add(new DiffItem.Warn("LOST_META", old.meta().displayName()));
        }
        List<String> referencing = referencingTables(model, old.id());
        if (!referencing.isEmpty()) {
            warns.add(new DiffItem.Warn("REFERENCED_BY", String.join(", ", referencing)));
        }
        return new DiffItem("table:" + old.id(), "table", "removed", old.id(), null,
                objectSummary(old.schema()), null,
                true, List.of(), List.of(), warns, List.of());
    }

    private List<DiffItem.Warn> renameWarnings(Table old, ProjectModel model) {
        List<String> pages = pagesWith(model, old.id());
        return pages.isEmpty() ? List.of()
                : List.of(new DiffItem.Warn("DIAGRAM_KEYS_UPDATED", String.join(", ", pages)));
    }

    // --------------------------------------------------------- テーブル内の差分

    private record TableChange(List<DiffItem> children) {}

    private TableChange compare(Table old, TableSchema neu, String newId,
                                Map<String, RenameDecision> decisions, ProjectModel model,
                                Set<String> addedIds, List<RenameCandidate> columnCandidates) {
        String tid = "table:" + newId;
        TableSchema oldSchema = old.schema();
        List<DiffItem> children = new ArrayList<>();

        Map<String, Column> oldCols = new LinkedHashMap<>();
        for (Column c : oldSchema.columns()) {
            oldCols.put(c.name(), c);
        }
        Map<String, Column> newCols = new LinkedHashMap<>();
        for (Column c : neu.columns()) {
            newCols.put(c.name(), c);
        }

        // カラムのリネーム候補（§4.3）。決定を反映して対応表を作る
        List<Column> droppedCols = oldSchema.columns().stream()
                .filter(c -> !newCols.containsKey(c.name())).toList();
        List<Column> newColsOnly = neu.columns().stream()
                .filter(c -> !oldCols.containsKey(c.name())).toList();
        List<RenameCandidate> colCandidates = renames.detectColumns(newId, droppedCols, newColsOnly,
                oldSchema.columns(), neu.columns());
        columnCandidates.addAll(colCandidates);

        Map<String, String> colPairs = new LinkedHashMap<>();   // 旧カラム名 → 新カラム名
        Set<String> colPairedTo = new HashSet<>();
        for (RenameCandidate c : colCandidates) {
            RenameDecision d = decisions.get(c.id());
            if (d != null && d.rejected()) continue;
            String to = d != null ? stripTable(newId, d.target()) : c.to();
            if (!newCols.containsKey(to) || oldCols.containsKey(to) || colPairedTo.contains(to)) continue;
            colPairs.put(c.from(), to);
            colPairedTo.add(to);
        }
        Map<String, String> reverse = new LinkedHashMap<>();
        colPairs.forEach((from, to) -> reverse.put(to, from));

        // ---- comment ----
        if (!Objects.equals(Normalize.comment(oldSchema.comment()), Normalize.comment(neu.comment()))) {
            children.add(DiffItem.of(tid + "/comment", "comment", "modified", newId,
                    oldSchema.comment(), neu.comment()));
        }

        // ---- kind（オブジェクト種別。K-16）----
        // ドライバ更新で TABLE_TYPE の文字列が変わったときに黙って書き換わらないよう、差分に出す
        if (!oldSchema.kind().equalsIgnoreCase(neu.kind())) {
            children.add(DiffItem.of(tid + "/kind", "objectKind", "modified", newId,
                    oldSchema.kind(), neu.kind()));
        }

        // ---- カラム ----
        Set<String> addedColumnIds = new LinkedHashSet<>();
        for (Column c : neu.columns()) {
            String oldName = reverse.getOrDefault(c.name(),
                    oldCols.containsKey(c.name()) ? c.name() : null);
            List<DiffItem> seeds = seedItems(tid, old, c, model);
            if (oldName == null) {
                String id = tid + "/column:" + c.name();
                addedColumnIds.add(id);
                children.add(new DiffItem(id, "column", "added", c.name(), null,
                        null, Normalize.columnSummary(c), true,
                        List.of(), List.of(), List.of(), seeds));
                continue;
            }
            Column oldCol = oldCols.get(oldName);
            if (!oldName.equals(c.name())) {
                // リネームは決定で駆動する（selectable = false）。配下の属性差分は定義ごと引き継ぐ
                children.add(new DiffItem(tid + "/column:" + c.name(), "column", "renamed", c.name(),
                        oldName,
                        oldName + " " + Normalize.columnSummary(oldCol),
                        c.name() + " " + Normalize.columnSummary(c),
                        false, List.of(), List.of(), List.of(), seeds));
            } else if (!Normalize.columnKey(oldCol).equals(Normalize.columnKey(c))) {
                children.add(new DiffItem(tid + "/column:" + c.name(), "column", "modified", c.name(),
                        null, Normalize.columnSummary(oldCol), Normalize.columnSummary(c),
                        true, List.of(), List.of(), List.of(), seeds));
            } else if (!seeds.isEmpty()) {
                children.add(new DiffItem(tid + "/column:" + c.name(), "column", "unchanged", c.name(),
                        null, null, null, false, List.of(), List.of(), List.of(), seeds));
            }
        }
        Map<String, String> removedColumnIds = new LinkedHashMap<>();  // カラム名 → 項目ID
        for (Column c : oldSchema.columns()) {
            if (newCols.containsKey(c.name()) || colPairs.containsKey(c.name())) continue;
            String id = tid + "/column:" + c.name();
            removedColumnIds.put(c.name(), id);
            children.add(new DiffItem(id, "column", "removed", c.name(), null,
                    Normalize.columnSummary(c), null, true, List.of(), List.of(),
                    lostColumnWarnings(old, c.name()), List.of()));
        }

        // ---- 主キー ----
        List<String> oldPk = rename(oldSchema.primaryKey(), colPairs);
        if (!oldPk.equals(neu.primaryKey())) {
            String change = oldPk.isEmpty() ? "added" : neu.primaryKey().isEmpty() ? "removed" : "modified";
            children.add(new DiffItem(tid + "/pk", "primaryKey", change, "PRIMARY KEY", null,
                    oldPk.isEmpty() ? null : String.join(", ", oldPk),
                    neu.primaryKey().isEmpty() ? null : String.join(", ", neu.primaryKey()),
                    true, requiresColumns(tid, neu.primaryKey(), addedColumnIds),
                    forcedByColumns(oldSchema.primaryKey(), removedColumnIds), List.of(), List.of()));
        }

        // ---- ユニーク制約 / インデックス / 外部キー ----
        constraintDiff(children, tid, "unique",
                map(oldSchema.uniques(), UniqueConstraint::name),
                map(neu.uniques(), UniqueConstraint::name),
                u -> String.join(", ", u.columns()),
                u -> rename(u.columns(), colPairs),
                UniqueConstraint::columns, addedColumnIds, removedColumnIds, List.of());
        constraintDiff(children, tid, "index",
                map(oldSchema.indexes(), IndexDef::name),
                map(neu.indexes(), IndexDef::name),
                ix -> String.join(", ", ix.columns()) + (ix.unique() ? " (unique)" : ""),
                ix -> rename(ix.columns(), colPairs),
                IndexDef::columns, addedColumnIds, removedColumnIds, List.of());
        fkDiff(children, tid, oldSchema.foreignKeys(), neu.foreignKeys(), colPairs,
                addedColumnIds, removedColumnIds, addedIds);

        // ---- dialect（Enhancer が取得した DB 固有情報。層2） ----
        if (!oldSchema.dialect().equals(neu.dialect())) {
            children.add(DiffItem.of(tid + "/dialect", "dialect", "modified", "dialect",
                    oldSchema.dialect().toString(), neu.dialect().toString()));
        }

        // ---- 論理名の初期値補完（K-14。テーブル） ----
        String seed = seedName(neu.comment());
        if (seed != null && isBlank(old.meta().displayName())) {
            children.add(new DiffItem(tid + "/displayName", "displayName", "added", neu.name(),
                    null, null, seed, true, List.of(), List.of(), List.of(), List.of()));
        }
        return new TableChange(children);
    }

    /** カラムの論理名の初期値補完（K-14）。個別設定にも辞書にも無いときだけ種をまく（§5.8.2）。 */
    private List<DiffItem> seedItems(String tid, Table old, Column c, ProjectModel model) {
        String seed = seedName(c.comment());
        if (seed == null) return List.of();
        var cm = old.meta().columns().get(c.name());
        if (cm != null && !isBlank(cm.displayName())) return List.of();
        if (model.dictionary().displayNameOf(c.name()) != null) return List.of();
        return List.of(new DiffItem(tid + "/column:" + c.name() + "/displayName", "displayName",
                "added", c.name(), null, null, seed, true,
                List.of(), List.of(), List.of(), List.of()));
    }

    private interface Named<T> {
        String columns(T value);
    }

    /** ユニーク制約・インデックスの差分（名前をキーに突き合わせる）。 */
    private <T> void constraintDiff(List<DiffItem> out, String tid, String kind,
                                    Map<String, T> old, Map<String, T> neu,
                                    Named<T> summary, java.util.function.Function<T, List<String>> oldCols,
                                    java.util.function.Function<T, List<String>> newCols,
                                    Set<String> addedColumnIds, Map<String, String> removedColumnIds,
                                    List<String> extraRequires) {
        String itemKind = "unique".equals(kind) ? "unique" : "index";
        for (Map.Entry<String, T> e : neu.entrySet()) {
            T o = old.get(e.getKey());
            String id = tid + "/" + kind + ":" + e.getKey();
            if (o == null) {
                out.add(new DiffItem(id, itemKind, "added", e.getKey(), null, null,
                        summary.columns(e.getValue()), true,
                        concat(requiresColumns(tid, newCols.apply(e.getValue()), addedColumnIds),
                                extraRequires),
                        List.of(), List.of(), List.of()));
            } else if (!oldCols.apply(o).equals(newCols.apply(e.getValue()))
                    || !summary.columns(o).equals(summary.columns(e.getValue()))) {
                out.add(new DiffItem(id, itemKind, "modified", e.getKey(), null,
                        summary.columns(o), summary.columns(e.getValue()), true,
                        requiresColumns(tid, newCols.apply(e.getValue()), addedColumnIds),
                        List.of(), List.of(), List.of()));
            }
        }
        for (Map.Entry<String, T> e : old.entrySet()) {
            if (neu.containsKey(e.getKey())) continue;
            List<String> forced = forcedByColumns(newCols.apply(e.getValue()), removedColumnIds);
            out.add(new DiffItem(tid + "/" + kind + ":" + e.getKey(), itemKind, "removed", e.getKey(),
                    null, summary.columns(e.getValue()), null, forced.isEmpty(), List.of(), forced,
                    List.of(), List.of()));
        }
    }

    private void fkDiff(List<DiffItem> out, String tid, List<ForeignKey> old, List<ForeignKey> neu,
                        Map<String, String> colPairs, Set<String> addedColumnIds,
                        Map<String, String> removedColumnIds, Set<String> addedTableIds) {
        Map<String, ForeignKey> oldByName = map(old, ForeignKey::name);
        Map<String, ForeignKey> newByName = map(neu, ForeignKey::name);
        for (Map.Entry<String, ForeignKey> e : newByName.entrySet()) {
            ForeignKey fk = e.getValue();
            ForeignKey o = oldByName.get(e.getKey());
            String id = tid + "/fk:" + e.getKey();
            // R-3: 参照先テーブルが既存であるか、同時に追加が選択されている必要がある
            List<String> requires = new ArrayList<>(requiresColumns(tid, fk.columns(), addedColumnIds));
            if (addedTableIds.contains(fk.ref().table())) {
                requires.add("table:" + fk.ref().table());
            }
            if (o == null) {
                out.add(new DiffItem(id, "foreignKey", "added", e.getKey(), null, null, fkSummary(fk),
                        true, requires, List.of(), List.of(), List.of()));
            } else {
                ForeignKey renamedOld = new ForeignKey(o.name(), rename(o.columns(), colPairs),
                        o.ref(), o.onDelete(), o.onUpdate());
                if (!Normalize.fkKey(renamedOld).equals(Normalize.fkKey(fk))) {
                    out.add(new DiffItem(id, "foreignKey", "modified", e.getKey(), null,
                            fkSummary(o), fkSummary(fk), true, requires,
                            List.of(), List.of(), List.of()));
                }
            }
        }
        for (Map.Entry<String, ForeignKey> e : oldByName.entrySet()) {
            if (newByName.containsKey(e.getKey())) continue;
            ForeignKey fk = e.getValue();
            List<String> forced = forcedByColumns(fk.columns(), removedColumnIds);
            out.add(new DiffItem(tid + "/fk:" + e.getKey(), "foreignKey", "removed", e.getKey(), null,
                    fkSummary(fk), null, forced.isEmpty(), List.of(), forced, List.of(), List.of()));
        }
    }

    /**
     * 削除されるテーブルを参照している FK の削除は、テーブル削除に強制的に連動させる（R-4）。
     * これを外せてしまうと、参照先を失った FK が残り、V-2（参照整合性）で適用が止まる。
     */
    private DiffItem forceFkRemovals(DiffItem table, Set<String> removedTableIds) {
        if (removedTableIds.isEmpty() || table.children().isEmpty()) return table;
        List<DiffItem> children = new ArrayList<>();
        boolean changed = false;
        for (DiffItem c : table.children()) {
            if ("foreignKey".equals(c.kind()) && "removed".equals(c.change()) && c.forcedBy().isEmpty()) {
                String refTable = refTableOf(c.before());
                if (refTable != null && removedTableIds.contains(refTable)) {
                    children.add(c.with(false, c.requires(), List.of("table:" + refTable),
                            c.warnings(), c.children()));
                    changed = true;
                    continue;
                }
            }
            children.add(c);
        }
        return changed ? table.withChildren(children) : table;
    }

    // ------------------------------------------------------------------ ガード

    /** 危険な差分（フィルタ・接続先の設定ミス）を適用前に止める（§8.5）。 */
    private List<DiffPlan.Guard> guards(DiffPlan.Stats stats, int existingCount, RawSchema raw,
                                        ProjectModel model, List<DiffItem> items) {
        List<DiffPlan.Guard> guards = new ArrayList<>();
        if (raw.tables().isEmpty()) {
            guards.add(new DiffPlan.Guard("EMPTY_RESULT", "error",
                    "No tables were found. Check the namespace setting."));
        }
        if (existingCount > 0 && stats.removed() * 2 >= existingCount) {
            guards.add(new DiffPlan.Guard("MASS_DELETE", "warn",
                    stats.removed() + " of " + existingCount
                            + " existing tables will be removed. Check the connection and filter settings."));
        }
        int placed = 0;
        Set<String> pages = new LinkedHashSet<>();
        for (DiffItem item : items) {
            if (!"table".equals(item.kind()) || !"removed".equals(item.change())) continue;
            List<String> p = pagesWith(model, item.target());
            if (!p.isEmpty()) {
                placed++;
                pages.addAll(p);
            }
        }
        if (placed > 0) {
            guards.add(new DiffPlan.Guard("PLACED_DELETE", "warn",
                    placed + " tables marked for removal are placed on " + pages.size()
                            + " pages. Their nodes will remain as orphans."));
        }
        return guards;
    }

    // -------------------------------------------------------------- ヘルパ

    private static List<String> pagesWith(ProjectModel model, String tableId) {
        List<String> pages = new ArrayList<>();
        for (DiagramPage d : model.diagramsSorted()) {
            if (d.nodes().containsKey(tableId)) pages.add(d.id());
        }
        return pages;
    }

    private static List<String> referencingTables(ProjectModel model, String tableId) {
        List<String> out = new ArrayList<>();
        for (Table t : model.tablesSorted()) {
            if (t.id().equals(tableId)) continue;
            boolean refs = t.schema().foreignKeys().stream()
                    .anyMatch(fk -> fk.ref().table().equals(tableId))
                    || t.meta().logicalForeignKeys().stream()
                    .anyMatch(fk -> fk.ref().table().equals(tableId));
            if (refs) out.add(t.id());
        }
        return out;
    }

    /** 削除されるカラムに紐づく人の情報（§3.2）。 */
    private static List<DiffItem.Warn> lostColumnWarnings(Table old, String column) {
        List<DiffItem.Warn> warns = new ArrayList<>();
        var cm = old.meta().columns().get(column);
        if (cm != null && !cm.isEmpty()) {
            warns.add(new DiffItem.Warn("LOST_COLUMN_META",
                    cm.displayName() != null ? cm.displayName() : cm.notes()));
        }
        for (LogicalUnique lu : old.meta().logicalUniques()) {
            if (lu.columns().contains(column)) {
                warns.add(new DiffItem.Warn("LOST_LOGICAL_UNIQUE", lu.name()));
            }
        }
        for (LogicalForeignKey lfk : old.meta().logicalForeignKeys()) {
            if (lfk.columns().contains(column)) {
                warns.add(new DiffItem.Warn("LOST_LOGICAL_FK", lfk.name()));
            }
        }
        return warns;
    }

    private static <T> Map<String, T> map(List<T> list, java.util.function.Function<T, String> key) {
        Map<String, T> out = new LinkedHashMap<>();
        for (T v : list) {
            out.put(key.apply(v), v);
        }
        return out;
    }

    private static List<String> rename(List<String> columns, Map<String, String> pairs) {
        if (pairs.isEmpty()) return columns;
        return columns.stream().map(c -> pairs.getOrDefault(c, c)).toList();
    }

    private static List<String> requiresColumns(String tid, List<String> columns,
                                                Set<String> addedColumnIds) {
        List<String> out = new ArrayList<>();
        for (String c : columns) {
            String id = tid + "/column:" + c;
            if (addedColumnIds.contains(id)) out.add(id);
        }
        return out;
    }

    private static List<String> forcedByColumns(List<String> columns,
                                                Map<String, String> removedColumnIds) {
        List<String> out = new ArrayList<>();
        for (String c : columns) {
            String id = removedColumnIds.get(c);
            if (id != null) out.add(id);
        }
        return out;
    }

    private static List<String> concat(List<String> a, List<String> b) {
        if (b.isEmpty()) return a;
        List<String> out = new ArrayList<>(a);
        out.addAll(b);
        return out;
    }

    /** 追加・削除の要約。通常テーブル以外は種別を頭に付ける（何が増減したのか一目で分かるように）。 */
    private static String objectSummary(TableSchema s) {
        String columns = s.columns().size() + " columns";
        return s.isTable() ? columns : s.kind() + ", " + columns;
    }

    private static String fkSummary(ForeignKey fk) {
        return String.join(", ", fk.columns()) + " → " + fk.ref().table()
                + "(" + String.join(", ", fk.ref().columns()) + ")"
                + " ON DELETE " + fk.onDelete() + " ON UPDATE " + fk.onUpdate();
    }

    private static String refTableOf(String fkSummary) {
        if (fkSummary == null) return null;
        int arrow = fkSummary.indexOf(" → ");
        if (arrow < 0) return null;
        String rest = fkSummary.substring(arrow + 3);
        int paren = rest.indexOf('(');
        return paren < 0 ? null : rest.substring(0, paren);
    }

    /** コメントの1行目を論理名の初期値とする（全文は comment に残る。§5.8.2）。 */
    static String seedName(String comment) {
        String c = Normalize.comment(comment);
        if (c == null) return null;
        String first = c.lines().findFirst().orElse("").trim();
        return first.isEmpty() ? null : first;
    }

    private static String stripTable(String tableId, String qualified) {
        if (qualified == null) return null;
        String prefix = tableId + ".";
        return qualified.startsWith(prefix) ? qualified.substring(prefix.length()) : qualified;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isEmpty();
    }
}
