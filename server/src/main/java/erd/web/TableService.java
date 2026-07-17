package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import erd.core.io.DataFileException;
import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.io.ProjectStore;
import erd.core.model.Column;
import erd.core.model.ForeignKey;
import erd.core.model.IndexDef;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalUnique;
import erd.core.model.Table;
import erd.core.model.UniqueConstraint;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * テーブル定義（meta を含む全文置換）の保存（O-03 / O-08 / J-05 / P-06〜P-08 / §4.1）。
 *
 * <p>PUT はテーブル1件の完全な定義を受け取り、machine-owned と meta の両方を置換する
 * （逆生成の適用が machine のみ置換するのとは非対称。O-03 詳細設計 §4.3）。
 * 保存後は何が変わったかを判定せず、無条件に index.js を再生成する（§8.2）。
 *
 * <p>リネーム（id / name / schema の変更）はこの API では受け付けない。リネームは
 * ER図の配置・他テーブルの参照への波及を伴い、RenameService（K-09 と同一実装）を
 * 経由する必要がある（O-03 詳細設計 §3。後続フェーズ）。
 */
public final class TableService {

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();
    private final ProjectStore store = new ProjectStore();

    /** フィールド単位のエラー / 警告（§7 の 422 レスポンス形式）。 */
    public record Issue(String path, String code, String message) {
        Map<String, String> toMap() {
            return Map.of("path", path, "code", code, "message", message);
        }
    }

    public sealed interface Outcome permits Ok, Stale, NotFound, Invalid {}

    /** writtenFiles: relPath → 新しい内容ハッシュ（SSE の自己判定に使う）。 */
    public record Ok(String newHash, Map<String, String> writtenFiles, List<Issue> warnings)
            implements Outcome {}

    public record Stale(String currentHash) implements Outcome {}

    public record NotFound() implements Outcome {}

    public record Invalid(List<Issue> errors, List<Issue> warnings) implements Outcome {}

    // ------------------------------------------------------------------ GET

    /** 編集画面の初期値（O-03 詳細設計 §7）。対象ファイルの baseHash を返す。無ければ null。 */
    public String baseHash(Path dataDir, String tableId) {
        Path file = tableFile(dataDir, tableId);
        if (file == null || !Files.isRegularFile(file)) return null;
        return Hashes.sha256(file);
    }

    // ------------------------------------------------------------------ PUT

    /**
     * @param body { baseHash, force, table: {...テーブル1件の完全な定義...} }
     */
    public Outcome put(Path dataDir, String tableId, JsonNode body) {
        Path file = tableFile(dataDir, tableId);
        if (file == null || !Files.isRegularFile(file)) return new NotFound();

        byte[] current;
        try {
            current = Files.readAllBytes(file);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        String currentHash = Hashes.sha256(current);
        boolean force = body.path("force").asBoolean(false);
        if (!force && !currentHash.equals(body.path("baseHash").asText(""))) {
            return new Stale(currentHash);
        }

        JsonNode tableNode = body.path("table");
        if (!tableNode.isObject()) {
            return new Invalid(List.of(new Issue("table", "BAD_REQUEST", "table object is required")),
                    List.of());
        }

        Table incoming;
        try {
            // ファイル本文と同じ形式のため、パーサをそのまま再利用する（未知キーの保持も同じ規則）
            incoming = parser.parseTable("ERD.table(" + tableNode + ");").value();
        } catch (DataFileException e) {
            return new Invalid(List.of(new Issue("table", "PARSE", e.getMessage())), List.of());
        }

        Table existing = parser.parseTable(new String(current, StandardCharsets.UTF_8)).value();

        // リネームはこの API の対象外（INV-1: リネームをリネームとして扱わない入口を作らない）
        if (!incoming.id().equals(tableId)
                || !incoming.schema().name().equals(existing.schema().name())
                || !equalsNullable(incoming.schema().schema(), existing.schema().schema())) {
            return new Invalid(List.of(new Issue("id", "RENAME_UNSUPPORTED",
                    "renaming a table is not supported by this endpoint")), List.of());
        }

        ProjectStore.LoadResult loaded = store.read(dataDir);
        Map<String, Table> byId = new HashMap<>();
        for (Table t : loaded.model().tables()) {
            byId.put(t.id(), t);
        }
        byId.put(incoming.id(), incoming);

        List<Issue> errors = new ArrayList<>();
        List<Issue> warnings = new ArrayList<>();
        validate(incoming, byId, errors, warnings);
        if (!errors.isEmpty()) {
            return new Invalid(errors, warnings);
        }

        String content = printer.printTable(incoming);
        String newHash = Hashes.sha256(content.getBytes(StandardCharsets.UTF_8));
        Map<String, String> written = new LinkedHashMap<>();
        try {
            if (!newHash.equals(currentHash)) {
                FileWrites.writeAtomic(file, content);
                written.put(dataDir.relativize(file).toString().replace('\\', '/'), newHash);
            }
            // 論理制約・論理名・タグはいずれも index.js に影響する。条件分岐せず必ず再生成する（P §4.3）
            List<Table> tables = new ArrayList<>(byId.values());
            String indexHash = FileWrites.regenerateIndex(dataDir, tables, loaded.model().diagrams());
            if (indexHash != null) {
                written.put("index.js", indexHash);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return new Ok(newHash, written, warnings);
    }

    // ----------------------------------------------------- バリデーション（P-08）

    private void validate(Table table, Map<String, Table> byId,
                          List<Issue> errors, List<Issue> warnings) {
        Map<String, Column> ownColumns = new HashMap<>();
        for (Column c : table.schema().columns()) {
            ownColumns.put(c.name(), c);
        }

        // V-1: 制約名の重複（論理一意制約・論理外部制約それぞれの名前空間内。
        // 物理 FK との同名は許す — エッジID は種別プレフィックスで衝突しない。P §4.4 / T-6）
        Set<String> luNames = new HashSet<>();
        List<LogicalUnique> lus = table.meta().logicalUniques();
        for (int i = 0; i < lus.size(); i++) {
            if (!luNames.add(lus.get(i).name())) {
                errors.add(new Issue("meta.logicalUniques[" + i + "].name", "DUPLICATE",
                        "duplicate logical unique name: " + lus.get(i).name()));
            }
        }
        Set<String> lfkNames = new HashSet<>();
        List<LogicalForeignKey> lfks = table.meta().logicalForeignKeys();
        for (int i = 0; i < lfks.size(); i++) {
            if (!lfkNames.add(lfks.get(i).name())) {
                errors.add(new Issue("meta.logicalForeignKeys[" + i + "].name", "DUPLICATE",
                        "duplicate logical foreign key name: " + lfks.get(i).name()));
            }
        }

        // 論理一意制約: V-2（参照カラムの存在）+ V-7（物理制約との重複は警告）
        for (int i = 0; i < lus.size(); i++) {
            LogicalUnique lu = lus.get(i);
            String path = "meta.logicalUniques[" + i + "]";
            if (lu.columns().isEmpty()) {
                errors.add(new Issue(path + ".columns", "EMPTY", "columns are required"));
                continue;
            }
            for (String col : lu.columns()) {
                if (!ownColumns.containsKey(col)) {
                    errors.add(new Issue(path + ".columns", "NOT_FOUND",
                            "column does not exist: " + col));
                }
            }
            if (hasPhysicalUniqueOn(table, lu.columns())) {
                warnings.add(new Issue(path, "DUPLICATE_PHYSICAL",
                        "a physical unique constraint already covers: " + String.join(", ", lu.columns())));
            }
        }

        // 論理外部制約: V-2〜V-6 / V-7 / V-8
        for (int i = 0; i < lfks.size(); i++) {
            validateLfk(table, lfks.get(i), i, ownColumns, byId, errors, warnings);
        }

        // meta.columns / meta.relations の孤児キー（存在しないカラム・制約への言及）は警告
        for (String col : table.meta().columns().keySet()) {
            if (!ownColumns.containsKey(col)) {
                warnings.add(new Issue("meta.columns." + col, "ORPHAN",
                        "column does not exist: " + col));
            }
        }
        validateRelations(table, errors, warnings);
    }

    private void validateLfk(Table table, LogicalForeignKey lfk, int i,
                             Map<String, Column> ownColumns, Map<String, Table> byId,
                             List<Issue> errors, List<Issue> warnings) {
        String path = "meta.logicalForeignKeys[" + i + "]";
        if (lfk.columns().isEmpty()) {
            errors.add(new Issue(path + ".columns", "EMPTY", "columns are required"));
            return;
        }
        boolean sourceOk = true;
        for (String col : lfk.columns()) {
            if (!ownColumns.containsKey(col)) {
                errors.add(new Issue(path + ".columns", "NOT_FOUND", "column does not exist: " + col));
                sourceOk = false;
            }
        }
        Table target = byId.get(lfk.ref().table());
        if (target == null) {
            errors.add(new Issue(path + ".ref.table", "NOT_FOUND",
                    "referenced table does not exist: " + lfk.ref().table()));
            return;
        }
        Map<String, Column> targetColumns = new HashMap<>();
        for (Column c : target.schema().columns()) {
            targetColumns.put(c.name(), c);
        }
        boolean targetOk = true;
        for (String col : lfk.ref().columns()) {
            if (!targetColumns.containsKey(col)) {
                errors.add(new Issue(path + ".ref.columns", "NOT_FOUND",
                        "referenced column does not exist: " + lfk.ref().table() + "." + col));
                targetOk = false;
            }
        }
        if (lfk.columns().size() != lfk.ref().columns().size()) {
            errors.add(new Issue(path + ".ref.columns", "COUNT_MISMATCH",
                    "column count mismatch (" + lfk.columns().size() + " -> "
                            + lfk.ref().columns().size() + ")"));
            return;
        }
        if (!sourceOk || !targetOk) return;

        // V-6: 参照先の一意性は警告（DB が保証しない論理制約であるため）
        if (!hasAnyUniqueOn(target, lfk.ref().columns())) {
            warnings.add(new Issue(path + ".ref.columns", "NOT_UNIQUE",
                    "referenced columns are not unique in " + lfk.ref().table()));
        }
        // V-7: 同一カラム構成の物理 FK が既に存在する
        for (ForeignKey fk : table.schema().foreignKeys()) {
            if (fk.columns().equals(lfk.columns()) && fk.ref().table().equals(lfk.ref().table())
                    && fk.ref().columns().equals(lfk.ref().columns())) {
                warnings.add(new Issue(path, "DUPLICATE_PHYSICAL",
                        "a physical foreign key already covers this reference: " + fk.name()));
            }
        }
        // V-8: 参照元と参照先の logicalType が異なる
        for (int j = 0; j < lfk.columns().size(); j++) {
            Column from = ownColumns.get(lfk.columns().get(j));
            Column to = targetColumns.get(lfk.ref().columns().get(j));
            if (from != null && to != null && from.logicalType() != to.logicalType()) {
                warnings.add(new Issue(path + ".columns", "TYPE_MISMATCH",
                        from.name() + " (" + from.logicalType().jsonName() + ") -> "
                                + to.name() + " (" + to.logicalType().jsonName() + ")"));
            }
        }
    }

    /** meta.relations（P-11）: キーの形式と値域を検証する。存在しない制約への言及は警告。 */
    private void validateRelations(Table table, List<Issue> errors, List<Issue> warnings) {
        Set<String> known = new HashSet<>();
        for (ForeignKey fk : table.schema().foreignKeys()) {
            known.add("fk:" + fk.name());
        }
        for (LogicalForeignKey lfk : table.meta().logicalForeignKeys()) {
            known.add("lfk:" + lfk.name());
        }
        Set<String> parentValues = Set.of("0..1", "1..1");
        Set<String> childValues = Set.of("0..1", "1..1", "0..N", "1..N");
        table.meta().relations().forEach((key, rm) -> {
            String path = "meta.relations." + key;
            if (!known.contains(key)) {
                warnings.add(new Issue(path, "ORPHAN", "no such constraint: " + key));
            }
            if (rm.parent() != null && !parentValues.contains(rm.parent())) {
                errors.add(new Issue(path + ".parent", "INVALID_VALUE",
                        "parent must be 0..1 or 1..1"));
            }
            if (rm.child() != null && !childValues.contains(rm.child())) {
                errors.add(new Issue(path + ".child", "INVALID_VALUE",
                        "child must be one of 0..1, 1..1, 0..N, 1..N"));
            }
        });
    }

    /** 物理の一意性（PK / ユニーク制約 / ユニークインデックス）がカラム集合を完全一致で覆うか。 */
    private static boolean hasPhysicalUniqueOn(Table table, List<String> columns) {
        Set<String> target = new HashSet<>(columns);
        if (!table.schema().primaryKey().isEmpty()
                && new HashSet<>(table.schema().primaryKey()).equals(target)) {
            return true;
        }
        for (UniqueConstraint u : table.schema().uniques()) {
            if (new HashSet<>(u.columns()).equals(target)) return true;
        }
        for (IndexDef ix : table.schema().indexes()) {
            if (ix.unique() && new HashSet<>(ix.columns()).equals(target)) return true;
        }
        return false;
    }

    /** 物理 + 論理一意制約のいずれかがカラム集合を覆うか（V-6 の判定）。 */
    private static boolean hasAnyUniqueOn(Table table, List<String> columns) {
        if (hasPhysicalUniqueOn(table, columns)) return true;
        Set<String> target = new HashSet<>(columns);
        for (LogicalUnique lu : table.meta().logicalUniques()) {
            if (new HashSet<>(lu.columns()).equals(target)) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- helper

    /** manifest からテーブルID → スキーマファイルを引く（パス正規化込み）。 */
    private Path tableFile(Path dataDir, String tableId) {
        String rel;
        try {
            rel = store.readManifestOnly(dataDir).tables().get(tableId);
        } catch (RuntimeException e) {
            return null;
        }
        if (rel == null) return null;
        Path base = dataDir.normalize();
        Path file = base.resolve(rel).normalize();
        return file.startsWith(base) ? file : null;
    }

    private static boolean equalsNullable(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }
}
