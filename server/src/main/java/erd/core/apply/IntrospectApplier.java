package erd.core.apply;

import erd.core.diff.DiffItem;
import erd.core.diff.DiffPlan;
import erd.core.model.Column;
import erd.core.model.ColumnMeta;
import erd.core.model.DiagramPage;
import erd.core.model.EdgeLayout;
import erd.core.model.ForeignKey;
import erd.core.model.IndexDef;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalUnique;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.ProjectModel;
import erd.core.model.Ref;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import erd.core.model.UniqueConstraint;
import erd.introspect.RawSchema;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * 差分の適用（K-11 詳細設計 §6）。<b>モデル → モデルの純粋な変換</b>であり、ファイルには触れない
 * （書き込み・バックアップ・アトミック置換は web 層の責務）。
 *
 * <p>本機能の核心は<b>手順4で meta を「そのまま保持」すること</b>である。変更の適用は
 * 「Table を丸ごと差し替える」のではなく、「machine-owned なフィールドだけを差し替え、
 * meta は既存インスタンスから引き継ぐ」（{@link Table#withSchema}）。丸ごと差し替えは
 * たった1行の見落としで INV-1 を破壊する。
 *
 * <p>diagrams は<b>リネーム承認時のキー書換以外では一切触らない</b>（INV-2）。座標は変えない。
 */
public final class IntrospectApplier {

    public ApplyResult apply(ProjectModel model, RawSchema raw, DiffPlan plan, Set<String> selection) {
        Map<String, DiffItem> index = plan.index();
        Map<String, TableSchema> db = new LinkedHashMap<>();
        for (TableSchema t : raw.tables()) {
            db.put(RawSchema.idOf(t), t);
        }

        // ---- §5.2 の依存性をサーバー側でも再検証する（クライアントを信用しない） ----
        List<String> violations = new ArrayList<>();
        for (DiffItem item : index.values()) {
            if (!applied(item, selection, index)) continue;
            for (String required : item.requires()) {
                DiffItem dep = index.get(required);
                if (dep == null || !applied(dep, selection, index)) {
                    violations.add(item.id());
                    break;
                }
            }
        }
        if (!violations.isEmpty()) {
            throw new DependencyException("Dependent items are not selected.", violations);
        }

        Map<String, Table> byId = new LinkedHashMap<>();
        for (Table t : model.tablesSorted()) {
            byId.put(t.id(), t);
        }

        Map<String, String> tableRenames = new LinkedHashMap<>();       // 旧ID → 新ID
        Map<String, Map<String, String>> columnRenames = new LinkedHashMap<>(); // 新ID → (旧カラム → 新カラム)
        List<String> skipped = new ArrayList<>();
        List<ApplyResult.Warning> warnings = new ArrayList<>();
        int added = 0;
        int removed = 0;
        int modified = 0;
        int renamedCount = 0;

        for (DiffItem item : plan.items()) {
            if (!"table".equals(item.kind())) continue;
            String id = item.target();
            switch (item.change()) {
                case "added" -> {
                    if (!applied(item, selection, index)) {
                        skipped.add(item.id());
                        continue;
                    }
                    TableSchema neu = db.get(id);
                    if (neu == null) continue;
                    byId.put(id, new Table(id, neu, TableMeta.EMPTY, Map.of()));
                    added++;
                }
                case "removed" -> {
                    if (!applied(item, selection, index)) {
                        skipped.add(item.id());
                        continue;
                    }
                    byId.remove(id);
                    removed++;
                }
                case "renamed" -> {
                    String oldId = item.renamedFrom();
                    Table old = byId.remove(oldId);
                    if (old == null) continue;
                    TableSchema neu = db.get(id);
                    Map<String, String> cols = columnPairs(item);
                    TableSchema merged = merge(old, neu, item, selection, index, cols);
                    byId.put(id, new Table(id, merged, renameMeta(old.meta(), cols), old.unknown()));
                    tableRenames.put(oldId, id);
                    if (!cols.isEmpty()) columnRenames.put(id, cols);
                    renamedCount++;
                    collectSkipped(item, selection, index, skipped);
                }
                case "modified" -> {
                    Table old = byId.get(id);
                    TableSchema neu = db.get(id);
                    if (old == null || neu == null) continue;
                    Map<String, String> cols = columnPairs(item);
                    TableSchema merged = merge(old, neu, item, selection, index, cols);
                    // meta は既存インスタンスから引き継ぐ（INV-1）。カラムリネーム分だけキーを付け替える
                    byId.put(id, new Table(id, merged, renameMeta(old.meta(), cols), old.unknown()));
                    if (!cols.isEmpty()) columnRenames.put(id, cols);
                    modified++;
                    collectSkipped(item, selection, index, skipped);
                }
                default -> { }
            }
        }

        // ---- リネームの波及（§4.5）: 他テーブルの参照と ER図のキー。座標は変えない（INV-2） ----
        List<Table> tables = new ArrayList<>(byId.values());
        if (!tableRenames.isEmpty() || !columnRenames.isEmpty()) {
            tables = tables.stream()
                    .map(t -> propagate(t, tableRenames, columnRenames))
                    .toList();
        }
        List<DiagramPage> diagrams = tableRenames.isEmpty()
                ? model.diagrams()
                : model.diagrams().stream().map(d -> rekey(d, tableRenames)).toList();

        // ---- 参照先を失った物理 FK は落とす（V-2。テーブル削除を適用した場合に起こりうる） ----
        Set<String> ids = new LinkedHashSet<>();
        for (Table t : tables) {
            ids.add(t.id());
        }
        List<Table> pruned = new ArrayList<>();
        for (Table t : tables) {
            List<ForeignKey> keep = t.schema().foreignKeys().stream()
                    .filter(fk -> ids.contains(fk.ref().table())).toList();
            if (keep.size() != t.schema().foreignKeys().size()) {
                for (ForeignKey fk : t.schema().foreignKeys()) {
                    if (!ids.contains(fk.ref().table())) {
                        warnings.add(new ApplyResult.Warning("FK_DROPPED",
                                "Dropped foreign key " + fk.name() + " on " + t.id()
                                        + " because target table " + fk.ref().table() + " does not exist."));
                    }
                }
                pruned.add(t.withSchema(withForeignKeys(t.schema(), keep)));
            } else {
                pruned.add(t);
            }
        }
        tables = pruned;

        // ---- 論理名の初期値補完（K-14。meta への唯一の書き込み。既存値は決して上書きしない） ----
        int seededTables = 0;
        int seededColumns = 0;
        List<Table> seeded = new ArrayList<>();
        for (Table t : tables) {
            String tableSeed = seedFor(index, selection, "table:" + t.id() + "/displayName");
            Map<String, String> columnSeeds = new LinkedHashMap<>();
            for (Column c : t.schema().columns()) {
                String s = seedFor(index, selection,
                        "table:" + t.id() + "/column:" + c.name() + "/displayName");
                if (s != null) columnSeeds.put(c.name(), s);
            }
            if (tableSeed == null && columnSeeds.isEmpty()) {
                seeded.add(t);
                continue;
            }
            TableMeta meta = t.meta();
            String displayName = meta.displayName();
            if (tableSeed != null && isBlank(displayName)) {
                displayName = tableSeed;
                seededTables++;
            }
            Map<String, ColumnMeta> columns = new LinkedHashMap<>(meta.columns());
            for (Map.Entry<String, String> e : columnSeeds.entrySet()) {
                ColumnMeta cm = columns.get(e.getKey());
                if (cm != null && !isBlank(cm.displayName())) continue;   // 既存値は上書きしない
                // 補完するのは論理名だけ。タグ・色・注記・未知キーはそのまま持ち越す（INV-1）
                columns.put(e.getKey(), cm == null
                        ? new ColumnMeta(e.getValue(), List.of(), null, null, Map.of())
                        : new ColumnMeta(e.getValue(), cm.tags(), cm.color(), cm.notes(), cm.unknown()));
                seededColumns++;
            }
            seeded.add(t.withMeta(new TableMeta(displayName, meta.tags(), meta.color(), meta.notes(),
                    columns, meta.logicalUniques(), meta.logicalForeignKeys(), meta.relations(),
                    meta.unknown())));
        }
        tables = seeded;

        // ---- 参照先を失った論理外部制約は「警告」に留める（V-3。人の定義を勝手に消さない） ----
        for (Table t : tables) {
            for (LogicalForeignKey lfk : t.meta().logicalForeignKeys()) {
                if (!ids.contains(lfk.ref().table())) {
                    warnings.add(new ApplyResult.Warning("LOGICAL_FK_DANGLING",
                            "Logical foreign key " + lfk.name() + " on " + t.id()
                                    + " references missing table " + lfk.ref().table() + "."));
                }
            }
        }

        // ---- 未配置テーブル（K-12）と孤児ノード（K-13） ----
        Set<String> placed = new LinkedHashSet<>();
        for (DiagramPage d : diagrams) {
            placed.addAll(d.nodes().keySet());
        }
        List<String> unplaced = new ArrayList<>();
        for (DiffItem item : plan.items()) {
            if ("table".equals(item.kind()) && "added".equals(item.change())
                    && applied(item, selection, index) && !placed.contains(item.target())) {
                unplaced.add(item.target());
            }
        }
        Map<String, List<String>> orphans = new LinkedHashMap<>();
        for (DiagramPage d : diagrams) {
            for (String node : d.nodes().keySet()) {
                if (!ids.contains(node)) {
                    orphans.computeIfAbsent(node, k -> new ArrayList<>()).add(d.id());
                }
            }
        }

        Manifest manifest = new Manifest(model.manifest().schemaVersion(),
                java.time.Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString(),
                new Manifest.Source(raw.product(), raw.version()),
                model.manifest().config(), model.manifest().dictionary(),
                model.manifest().tables(), model.manifest().diagrams(), model.manifest().unknown());

        tables = tables.stream().sorted(Comparator.comparing(Table::id)).toList();
        ProjectModel result = new ProjectModel(manifest, model.config(), model.dictionary(),
                tables, diagrams);
        return new ApplyResult(result,
                new ApplyResult.Counts(added, removed, modified, renamedCount),
                skipped, seededTables, seededColumns, unplaced,
                orphans.entrySet().stream()
                        .map(e -> new ApplyResult.Orphan(e.getKey(), e.getValue())).toList(),
                warnings);
    }

    // ---------------------------------------------------------------- 選択判定

    /**
     * 適用されるか。
     * <ul>
     *   <li>選択可能な項目: 選択されていれば適用</li>
     *   <li>{@code forcedBy} を持つ項目: 引き金（カラム削除・テーブル削除）が適用されるなら強制適用（R-4 / R-6）</li>
     *   <li>それ以外の選択不可項目: リネーム（決定で駆動）または追加テーブルの配下（親と一体）</li>
     * </ul>
     */
    private static boolean applied(DiffItem item, Set<String> selection, Map<String, DiffItem> index) {
        if (item.selectable()) return selection.contains(item.id());
        if (!item.forcedBy().isEmpty()) {
            return item.forcedBy().stream().anyMatch(id -> {
                DiffItem trigger = index.get(id);
                return trigger != null && applied(trigger, selection, index);
            });
        }
        return true;
    }

    private static void collectSkipped(DiffItem table, Set<String> selection,
                                       Map<String, DiffItem> index, List<String> skipped) {
        for (DiffItem child : table.children()) {
            if (child.selectable() && !selection.contains(child.id())) {
                skipped.add(child.id());
            }
            collectSkipped(child, selection, index, skipped);
        }
    }

    private static String seedFor(Map<String, DiffItem> index, Set<String> selection, String id) {
        DiffItem item = index.get(id);
        return item != null && applied(item, selection, index) ? item.after() : null;
    }

    // ------------------------------------------------------- スキーマのマージ

    private static Map<String, String> columnPairs(DiffItem table) {
        Map<String, String> pairs = new LinkedHashMap<>();
        for (DiffItem c : table.children()) {
            if ("column".equals(c.kind()) && "renamed".equals(c.change())) {
                pairs.put(c.renamedFrom(), c.target());
            }
        }
        return pairs;
    }

    /**
     * 選択された項目だけを machine-owned フィールドに適用する。全項目が選択されていれば
     * DB の定義をそのまま採用する（カラム順を DB の物理順に保つ。§5.11）。
     */
    private TableSchema merge(Table old, TableSchema neu, DiffItem tableItem,
                              Set<String> selection, Map<String, DiffItem> index,
                              Map<String, String> colPairs) {
        if (neu == null) return old.schema();
        Map<String, DiffItem> children = new LinkedHashMap<>();
        boolean all = true;
        for (DiffItem c : tableItem.children()) {
            if ("displayName".equals(c.kind()) || "unchanged".equals(c.change())) continue;
            children.put(c.id(), c);
            if (!applied(c, selection, index)) all = false;
        }
        if (all) return neu;

        String tid = tableItem.id();
        TableSchema oldSchema = old.schema();
        Map<String, Column> newByName = new LinkedHashMap<>();
        for (Column c : neu.columns()) {
            newByName.put(c.name(), c);
        }

        List<Column> columns = new ArrayList<>();
        Set<String> emitted = new LinkedHashSet<>();
        for (Column oc : oldSchema.columns()) {
            String newName = colPairs.get(oc.name());
            if (newName == null && newByName.containsKey(oc.name())) newName = oc.name();
            if (newName == null) {
                DiffItem removal = children.get(tid + "/column:" + oc.name());
                if (removal != null && applied(removal, selection, index)) continue;
                columns.add(oc);
                emitted.add(oc.name());
                continue;
            }
            DiffItem item = children.get(tid + "/column:" + newName);
            Column nc = newByName.get(newName);
            boolean take = item == null || "renamed".equals(item.change())
                    || applied(item, selection, index);
            columns.add(take ? nc : oc);
            emitted.add(take ? nc.name() : oc.name());
        }
        for (Column nc : neu.columns()) {
            if (emitted.contains(nc.name())) continue;
            DiffItem item = children.get(tid + "/column:" + nc.name());
            if (item != null && "added".equals(item.change()) && applied(item, selection, index)) {
                columns.add(nc);
                emitted.add(nc.name());
            }
        }
        Set<String> live = new LinkedHashSet<>();
        for (Column c : columns) {
            live.add(c.name());
        }

        DiffItem pk = children.get(tid + "/pk");
        List<String> primaryKey = pk != null && applied(pk, selection, index)
                ? neu.primaryKey()
                : renameColumns(oldSchema.primaryKey(), colPairs);
        primaryKey = primaryKey.stream().filter(live::contains).toList();

        List<UniqueConstraint> uniques = mergeList(children, selection, index, tid + "/unique:",
                oldSchema.uniques(), neu.uniques(), UniqueConstraint::name,
                u -> new UniqueConstraint(u.name(), renameColumns(u.columns(), colPairs)),
                u -> live.containsAll(u.columns()));
        List<IndexDef> indexes = mergeList(children, selection, index, tid + "/index:",
                oldSchema.indexes(), neu.indexes(), IndexDef::name,
                ix -> new IndexDef(ix.name(), renameColumns(ix.columns(), colPairs), ix.unique()),
                ix -> live.containsAll(ix.columns()));
        List<ForeignKey> foreignKeys = mergeList(children, selection, index, tid + "/fk:",
                oldSchema.foreignKeys(), neu.foreignKeys(), ForeignKey::name,
                fk -> new ForeignKey(fk.name(), renameColumns(fk.columns(), colPairs), fk.ref(),
                        fk.onDelete(), fk.onUpdate()),
                fk -> live.containsAll(fk.columns()));

        DiffItem comment = children.get(tid + "/comment");
        String commentValue = comment == null || applied(comment, selection, index)
                ? neu.comment() : oldSchema.comment();
        DiffItem kind = children.get(tid + "/kind");
        String kindValue = kind == null || applied(kind, selection, index)
                ? neu.kind() : oldSchema.kind();
        DiffItem dialect = children.get(tid + "/dialect");
        var dialectValue = dialect == null || applied(dialect, selection, index)
                ? neu.dialect() : oldSchema.dialect();

        return new TableSchema(neu.name(), neu.schema(), kindValue, commentValue, columns,
                primaryKey, uniques, indexes, foreignKeys, dialectValue);
    }

    /** 制約リストの部分適用。選択されていない削除は残し、選択されていない変更は旧定義のままにする。 */
    private static <T> List<T> mergeList(Map<String, DiffItem> children, Set<String> selection,
                                         Map<String, DiffItem> index, String idPrefix,
                                         List<T> old, List<T> neu, Function<T, String> name,
                                         Function<T, T> renameCols,
                                         java.util.function.Predicate<T> columnsExist) {
        Map<String, T> newByName = new LinkedHashMap<>();
        for (T v : neu) {
            newByName.put(name.apply(v), v);
        }
        List<T> out = new ArrayList<>();
        Set<String> emitted = new LinkedHashSet<>();
        for (T ov : old) {
            String n = name.apply(ov);
            DiffItem item = children.get(idPrefix + n);
            T nv = newByName.get(n);
            if (item == null) {
                T value = nv != null ? nv : renameCols.apply(ov);
                if (columnsExist.test(value)) {
                    out.add(value);
                    emitted.add(n);
                }
                continue;
            }
            if ("removed".equals(item.change())) {
                if (applied(item, selection, index)) continue;
                T value = renameCols.apply(ov);
                if (columnsExist.test(value)) {
                    out.add(value);
                    emitted.add(n);
                }
            } else if ("modified".equals(item.change())) {
                T value = applied(item, selection, index) ? nv : renameCols.apply(ov);
                if (value != null && columnsExist.test(value)) {
                    out.add(value);
                    emitted.add(n);
                }
            }
        }
        for (T nv : neu) {
            String n = name.apply(nv);
            if (emitted.contains(n)) continue;
            DiffItem item = children.get(idPrefix + n);
            if (item != null && "added".equals(item.change()) && applied(item, selection, index)
                    && columnsExist.test(nv)) {
                out.add(nv);
            }
        }
        return out;
    }

    /** FK だけを差し替える。<b>kind を引き継ぎ忘れると、剪定が走ったビューが黙ってテーブルに戻る。</b> */
    private static TableSchema withForeignKeys(TableSchema s, List<ForeignKey> fks) {
        return new TableSchema(s.name(), s.schema(), s.kind(), s.comment(), s.columns(),
                s.primaryKey(), s.uniques(), s.indexes(), fks, s.dialect());
    }

    // ------------------------------------------------------- リネームの波及

    /** カラムリネーム: meta.columns のキーと、論理制約が参照するカラム名を付け替える（§4.5）。 */
    private static TableMeta renameMeta(TableMeta meta, Map<String, String> colPairs) {
        if (colPairs.isEmpty()) return meta;
        Map<String, ColumnMeta> columns = new LinkedHashMap<>();
        meta.columns().forEach((name, cm) -> columns.put(colPairs.getOrDefault(name, name), cm));
        List<LogicalUnique> uniques = meta.logicalUniques().stream()
                .map(lu -> new LogicalUnique(lu.name(), renameColumns(lu.columns(), colPairs), lu.notes()))
                .toList();
        List<LogicalForeignKey> fks = meta.logicalForeignKeys().stream()
                .map(lfk -> new LogicalForeignKey(lfk.name(), renameColumns(lfk.columns(), colPairs),
                        lfk.ref(), lfk.notes()))
                .toList();
        return new TableMeta(meta.displayName(), meta.tags(), meta.color(), meta.notes(), columns,
                uniques, fks, meta.relations(), meta.unknown());
    }

    /** 他テーブルからの参照（物理 FK・論理外部制約）をリネームに追随させる（§4.5）。 */
    private static Table propagate(Table t, Map<String, String> tableRenames,
                                   Map<String, Map<String, String>> columnRenames) {
        List<ForeignKey> fks = t.schema().foreignKeys().stream()
                .map(fk -> new ForeignKey(fk.name(), fk.columns(),
                        renameRef(fk.ref(), tableRenames, columnRenames), fk.onDelete(), fk.onUpdate()))
                .toList();
        List<LogicalForeignKey> lfks = t.meta().logicalForeignKeys().stream()
                .map(lfk -> new LogicalForeignKey(lfk.name(), lfk.columns(),
                        renameRef(lfk.ref(), tableRenames, columnRenames), lfk.notes()))
                .toList();
        Table out = t.withSchema(withForeignKeys(t.schema(), fks));
        TableMeta meta = out.meta();
        return out.withMeta(new TableMeta(meta.displayName(), meta.tags(), meta.color(), meta.notes(),
                meta.columns(), meta.logicalUniques(), lfks, meta.relations(), meta.unknown()));
    }

    private static Ref renameRef(Ref ref, Map<String, String> tableRenames,
                                 Map<String, Map<String, String>> columnRenames) {
        String table = tableRenames.getOrDefault(ref.table(), ref.table());
        Map<String, String> cols = columnRenames.get(table);
        return new Ref(table, cols == null ? ref.columns() : renameColumns(ref.columns(), cols));
    }

    /**
     * ER図のキー書換（§4.5）。nodes のキー（テーブルID）と edges のキー
     * （{@code <テーブルID>#<種別>:<制約名>}）を書き換える。<b>座標は変えない</b>（INV-2）。
     */
    private static DiagramPage rekey(DiagramPage d, Map<String, String> tableRenames) {
        Map<String, NodeLayout> nodes = new LinkedHashMap<>();
        d.nodes().forEach((id, n) -> nodes.put(tableRenames.getOrDefault(id, id), n));
        Map<String, EdgeLayout> edges = new LinkedHashMap<>();
        d.edges().forEach((key, e) -> {
            int hash = key.indexOf('#');
            if (hash > 0) {
                String tableId = key.substring(0, hash);
                String renamed = tableRenames.get(tableId);
                if (renamed != null) {
                    edges.put(renamed + key.substring(hash), e);
                    return;
                }
            }
            edges.put(key, e);
        });
        return new DiagramPage(d.id(), d.title(), d.order(), nodes, edges, d.unknown());
    }

    private static List<String> renameColumns(List<String> columns, Map<String, String> pairs) {
        if (pairs.isEmpty()) return columns;
        return columns.stream().map(c -> pairs.getOrDefault(c, c)).toList();
    }

    private static boolean isBlank(String s) {
        return s == null || s.isEmpty();
    }
}
