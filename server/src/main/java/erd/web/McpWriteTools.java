package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.io.DataFileParser;
import erd.core.model.ColumnMeta;
import erd.core.model.Dictionary;
import erd.core.model.DictionaryColumn;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalUnique;
import erd.core.model.Ref;
import erd.core.model.RelationMeta;
import erd.core.model.Table;
import erd.core.model.TableMeta;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * MCP の書き込みツール（Q-03。論理情報）。
 *
 * <p><b>物理情報（machine-owned）には触れない（INV-1）。</b> ここで書けるのは
 * {@code meta}（論理名・注記・タグ・色・論理制約）、カラム辞書、無視リストだけである。
 * 引数に物理情報のキーが混ざっていたら<b>黙って捨てずに拒否する</b> — 無視したことを
 * 伝えないと、モデルは書けたつもりで先へ進む。
 *
 * <p><b>既存サービスを必ず経由する（INV-4）。</b> 決定論的プリンタ・{@code index.js} の再生成・
 * 一時ファイル + {@code ATOMIC_MOVE}・P-08 の検証はすべて {@link TableService} 等の中にあり、
 * ここは「現在値を読む → {@code meta} だけ差し替える → サービスに渡す」の薄いマージ層にすぎない。
 *
 * <p><b>{@code force} は使わない（INV-5）。</b> read-modify-write を1回の呼び出しの中で完結させるので
 * {@code STALE} はほぼ起きないが、起きたら1回だけ読み直して再試行し、それでも駄目なら諦めて伝える。
 */
final class McpWriteTools {

    /** STALE のときの再試行回数（初回を含めた試行数）。 */
    private static final int ATTEMPTS = 2;

    private final ObjectMapper mapper = new ObjectMapper();
    private final DataFileParser parser = new DataFileParser();
    private final TableService tables = new TableService();
    private final DictionaryService dictionary = new DictionaryService();
    private final ConfigService config = new ConfigService();
    private final McpBackups backups = new McpBackups();

    // ----------------------------------------------------------- tools/list

    static final List<String> NAMES = List.of(
            "erd_set_table_meta",
            "erd_set_logical_constraints",
            "erd_set_dictionary_entry",
            "erd_set_ignore_tables");

    void define(ArrayNode tools, McpTools.Defs defs) {
        tools.add(defs.tool("erd_set_table_meta",
                "Update human-written information on a table: logical name (displayName), notes, tags, "
                        + "color, and the same per column. Only the fields you pass are changed; pass null to "
                        + "clear one. Physical information (column types, keys, indexes) cannot be changed "
                        + "here — it comes from the database.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("tableId", defs.str("Fully qualified table id, e.g. \"public.orders\"."));
                    props.set("displayName", defs.str("Logical (human-readable) table name."));
                    props.set("notes", defs.str("Free-form notes about the table (Markdown is fine)."));
                    props.set("tags", defs.strArray("Tags. Replaces the whole list."));
                    props.set("color", defs.enumStr("Color token.",
                            "gray", "red", "amber", "green", "blue", "purple", "muted"));
                    ObjectNode column = mapper.createObjectNode().put("type", "object");
                    ObjectNode cp = column.putObject("properties");
                    cp.set("name", defs.str("Physical column name (must exist on the table)."));
                    cp.set("displayName", defs.str("Logical column name."));
                    cp.set("notes", defs.str("Notes about the column."));
                    cp.set("tags", defs.strArray("Tags. Replaces the whole list."));
                    cp.set("color", defs.enumStr("Color token.",
                            "gray", "red", "amber", "green", "blue", "purple", "muted"));
                    column.putArray("required").add("name");
                    column.put("additionalProperties", false);
                    ObjectNode columns = mapper.createObjectNode().put("type", "array");
                    columns.set("items", column);
                    columns.put("description", "Per-column updates. Columns not listed are untouched.");
                    props.set("columns", columns);
                }, "tableId"));

        tools.add(defs.tool("erd_set_logical_constraints",
                "Define relationships and uniqueness that exist in the application but not as database "
                        + "constraints. Logical foreign keys are drawn as dashed edges on ER diagrams. "
                        + "Each list you pass replaces that list entirely; omit a list to keep it.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("tableId", defs.str("Fully qualified table id that holds the referencing columns."));

                    ObjectNode lfk = mapper.createObjectNode().put("type", "object");
                    ObjectNode lp = lfk.putObject("properties");
                    lp.set("name", defs.str("Constraint name, unique within the table, e.g. \"lfk_orders_user\"."));
                    lp.set("columns", defs.strArray("Referencing columns on this table."));
                    lp.set("references", defs.str("Referenced table id, e.g. \"public.users\"."));
                    lp.set("referencedColumns", defs.strArray("Referenced columns, same count and order."));
                    lp.set("notes", defs.str("Why this relationship exists (optional)."));
                    ArrayNode lreq = lfk.putArray("required");
                    lreq.add("name").add("columns").add("references").add("referencedColumns");
                    lfk.put("additionalProperties", false);
                    ObjectNode lfks = mapper.createObjectNode().put("type", "array");
                    lfks.set("items", lfk);
                    props.set("logicalForeignKeys", lfks);

                    ObjectNode lu = mapper.createObjectNode().put("type", "object");
                    ObjectNode up = lu.putObject("properties");
                    up.set("name", defs.str("Constraint name, unique within the table."));
                    up.set("columns", defs.strArray("Columns that are unique together."));
                    up.set("notes", defs.str("Optional notes."));
                    lu.putArray("required").add("name").add("columns");
                    lu.put("additionalProperties", false);
                    ObjectNode lus = mapper.createObjectNode().put("type", "array");
                    lus.set("items", lu);
                    props.set("logicalUniques", lus);

                    ObjectNode rel = mapper.createObjectNode().put("type", "object");
                    rel.put("description", "Cardinality overrides keyed by constraint name (physical FK or "
                            + "logical FK on this table). parent/child use \"0..1\", \"1..1\", \"0..N\", \"1..N\".");
                    ObjectNode relItem = mapper.createObjectNode().put("type", "object");
                    ObjectNode rp = relItem.putObject("properties");
                    rp.set("parent", defs.str("Cardinality on the referenced (parent) side."));
                    rp.set("child", defs.str("Cardinality on the referencing (child) side."));
                    rp.set("notes", defs.str("Reasoning (optional)."));
                    relItem.put("additionalProperties", false);
                    rel.set("additionalProperties", relItem);
                    props.set("relations", rel);
                }, "tableId"));

        tools.add(defs.tool("erd_set_dictionary_entry",
                "Set the shared logical name, tags or color for every column with this physical name "
                        + "across the workspace (the column dictionary). Per-table settings still win. "
                        + "Pass null for displayName, tags and color together to remove the entry.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("column", defs.str("Physical column name, e.g. \"created_at\"."));
                    props.set("displayName", defs.str("Shared logical name."));
                    props.set("tags", defs.strArray("Shared tags. Replaces the whole list."));
                    props.set("color", defs.enumStr("Color token.",
                            "gray", "red", "amber", "green", "blue", "purple", "muted"));
                }, "column"));

        tools.add(defs.tool("erd_set_ignore_tables",
                "Replace the workspace's ignore list: tables that must be treated as if they did not "
                        + "exist when importing from the database. Exact ids, globs (* and ?) or /regex/. "
                        + "Existing definitions of ignored tables are kept; they just stop being compared.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("patterns", defs.strArray("The complete new list."));
                }, "patterns"));
    }

    // ----------------------------------------------------------- tools/call

    String call(Path root, String workspaceId, Path dataDir, String name, JsonNode args) {
        // どの書き込みも、その前に data/** をスナップショットする（Q-06。回復の最後から2番目の砦）
        backups.beforeWrite(root, workspaceId, dataDir);
        return switch (name) {
            case "erd_set_table_meta" -> setTableMeta(dataDir, args);
            case "erd_set_logical_constraints" -> setLogicalConstraints(dataDir, args);
            case "erd_set_dictionary_entry" -> setDictionaryEntry(dataDir, args);
            case "erd_set_ignore_tables" -> setIgnoreTables(dataDir, args);
            default -> throw new IllegalArgumentException("Unknown tool: " + name);
        };
    }

    // ------------------------------------------------------- erd_set_table_meta

    private static final Set<String> TABLE_META_KEYS =
            Set.of("workspace", "tableId", "displayName", "notes", "tags", "color", "columns");
    private static final Set<String> COLUMN_META_KEYS =
            Set.of("name", "displayName", "notes", "tags", "color");

    private String setTableMeta(Path dataDir, JsonNode args) {
        rejectUnknownKeys(args, TABLE_META_KEYS, "");
        String tableId = McpTools.required(args, "tableId");
        for (JsonNode c : args.path("columns")) {
            rejectUnknownKeys(c, COLUMN_META_KEYS, "columns[]");
        }

        return writeTable(dataDir, tableId, existing -> {
            TableMeta m = existing.meta();
            String displayName = patchText(args, "displayName", m.displayName());
            String notes = patchText(args, "notes", m.notes());
            List<String> tags = patchStrings(args, "tags", m.tags());
            String color = patchText(args, "color", m.color());

            Map<String, ColumnMeta> columns = new LinkedHashMap<>(m.columns());
            Set<String> physical = new java.util.HashSet<>();
            existing.schema().columns().forEach(c -> physical.add(c.name()));
            for (JsonNode c : args.path("columns")) {
                String colName = McpTools.required(c, "name");
                if (!physical.contains(colName)) {
                    throw new McpTools.ToolException("Column \"" + colName + "\" does not exist on "
                            + tableId + ". Columns: " + String.join(", ", physical));
                }
                ColumnMeta cm = columns.get(colName);
                ColumnMeta merged = new ColumnMeta(
                        patchText(c, "displayName", cm == null ? null : cm.displayName()),
                        patchStrings(c, "tags", cm == null ? List.of() : cm.tags()),
                        patchText(c, "color", cm == null ? null : cm.color()),
                        patchText(c, "notes", cm == null ? null : cm.notes()),
                        cm == null ? Map.of() : cm.unknown());
                if (merged.isEmpty()) columns.remove(colName);
                else columns.put(colName, merged);
            }
            return existing.withMeta(new TableMeta(displayName, tags, color, notes, columns,
                    m.logicalUniques(), m.logicalForeignKeys(), m.relations(), m.unknown()));
        });
    }

    // ------------------------------------------------ erd_set_logical_constraints

    private static final Set<String> CONSTRAINT_KEYS =
            Set.of("workspace", "tableId", "logicalForeignKeys", "logicalUniques", "relations");

    private String setLogicalConstraints(Path dataDir, JsonNode args) {
        rejectUnknownKeys(args, CONSTRAINT_KEYS, "");
        String tableId = McpTools.required(args, "tableId");

        return writeTable(dataDir, tableId, existing -> {
            TableMeta m = existing.meta();

            List<LogicalForeignKey> lfks = m.logicalForeignKeys();
            if (args.hasNonNull("logicalForeignKeys")) {
                lfks = new ArrayList<>();
                for (JsonNode n : args.get("logicalForeignKeys")) {
                    rejectUnknownKeys(n, Set.of("name", "columns", "references", "referencedColumns", "notes"),
                            "logicalForeignKeys[]");
                    lfks.add(new LogicalForeignKey(
                            McpTools.required(n, "name"),
                            strings(n.path("columns")),
                            new Ref(McpTools.required(n, "references"), strings(n.path("referencedColumns"))),
                            McpTools.text(n, "notes").isEmpty() ? null : McpTools.text(n, "notes")));
                }
            }

            List<LogicalUnique> lus = m.logicalUniques();
            if (args.hasNonNull("logicalUniques")) {
                lus = new ArrayList<>();
                for (JsonNode n : args.get("logicalUniques")) {
                    rejectUnknownKeys(n, Set.of("name", "columns", "notes"), "logicalUniques[]");
                    lus.add(new LogicalUnique(McpTools.required(n, "name"), strings(n.path("columns")),
                            McpTools.text(n, "notes").isEmpty() ? null : McpTools.text(n, "notes")));
                }
            }

            Map<String, RelationMeta> relations = m.relations();
            if (args.hasNonNull("relations")) {
                relations = new LinkedHashMap<>();
                JsonNode r = args.get("relations");
                for (Iterator<String> it = r.fieldNames(); it.hasNext(); ) {
                    String key = it.next();
                    JsonNode n = r.get(key);
                    rejectUnknownKeys(n, Set.of("parent", "child", "notes"), "relations." + key);
                    relations.put(key, new RelationMeta(
                            McpTools.text(n, "parent").isEmpty() ? null : McpTools.text(n, "parent"),
                            McpTools.text(n, "child").isEmpty() ? null : McpTools.text(n, "child"),
                            McpTools.text(n, "notes").isEmpty() ? null : McpTools.text(n, "notes")));
                }
            }

            return existing.withMeta(new TableMeta(m.displayName(), m.tags(), m.color(), m.notes(),
                    m.columns(), lus, lfks, relations, m.unknown()));
        });
    }

    // ---------------------------------------------------- erd_set_dictionary_entry

    private String setDictionaryEntry(Path dataDir, JsonNode args) {
        rejectUnknownKeys(args, Set.of("workspace", "column", "displayName", "tags", "color"), "");
        String column = McpTools.required(args, "column");

        return retry(() -> {
            Path file = dataDir.resolve("dictionary.js");
            Dictionary existing = Dictionary.EMPTY;
            String baseHash = "";
            if (Files.isRegularFile(file)) {
                String content = read(file);
                baseHash = Hashes.sha256(content.getBytes(StandardCharsets.UTF_8));
                existing = parser.parseDictionary(content).value();
            }
            DictionaryColumn old = existing.columns().get(column);

            // DictionaryService.put は全件置換なので、既存を全部載せてから1件だけ差し替える
            ObjectNode body = mapper.createObjectNode();
            body.put("baseHash", baseHash);
            ObjectNode columns = body.putObject("columns");
            for (Map.Entry<String, DictionaryColumn> e : existing.columns().entrySet()) {
                if (e.getKey().equals(column)) continue;
                columns.set(e.getKey(), dictionaryJson(e.getValue()));
            }
            DictionaryColumn merged = new DictionaryColumn(
                    patchText(args, "displayName", old == null ? null : old.displayName()),
                    patchStrings(args, "tags", old == null ? List.of() : old.tags()),
                    patchText(args, "color", old == null ? null : old.color()),
                    old == null ? Map.of() : old.unknown());
            // 全部空にしたらエントリ削除（サービス側の規則と同じ）
            if (!merged.isEmpty()) columns.set(column, dictionaryJson(merged));

            DictionaryService.Outcome outcome = dictionary.put(dataDir, body);
            if (outcome instanceof DictionaryService.Ok ok) {
                return done("column", column, ok.writtenFiles(), List.of());
            }
            if (outcome instanceof DictionaryService.Stale) return null;
            if (outcome instanceof DictionaryService.Invalid invalid) {
                throw new McpTools.ToolException(issues(invalid.errors()));
            }
            if (outcome instanceof DictionaryService.BadRequest bad) {
                throw new McpTools.ToolException(bad.message());
            }
            throw new IllegalStateException("unexpected outcome: " + outcome);
        });
    }

    private ObjectNode dictionaryJson(DictionaryColumn c) {
        ObjectNode node = mapper.createObjectNode();
        if (c.displayName() != null) node.put("displayName", c.displayName());
        ArrayNode tags = node.putArray("tags");
        c.tags().forEach(tags::add);
        if (c.color() != null) node.put("color", c.color());
        return node;
    }

    // ------------------------------------------------------ erd_set_ignore_tables

    private String setIgnoreTables(Path dataDir, JsonNode args) {
        rejectUnknownKeys(args, Set.of("workspace", "patterns"), "");
        if (!args.path("patterns").isArray()) {
            throw new McpTools.ToolException("\"patterns\" must be an array of strings (may be empty).");
        }
        return retry(() -> {
            Path file = dataDir.resolve("config.js");
            String baseHash = Files.isRegularFile(file) ? Hashes.sha256(file) : "";
            ObjectNode body = mapper.createObjectNode();
            body.put("baseHash", baseHash);
            ArrayNode patterns = body.putArray("ignoreTables");
            args.path("patterns").forEach(p -> patterns.add(p.asText("")));

            ConfigService.Outcome outcome = config.put(dataDir, body);
            if (outcome instanceof ConfigService.Ok ok) {
                return done("patterns", String.valueOf(patterns.size()), ok.writtenFiles(), List.of());
            }
            if (outcome instanceof ConfigService.Stale) return null;
            if (outcome instanceof ConfigService.Invalid invalid) {
                throw new McpTools.ToolException(invalid.message());
            }
            throw new IllegalStateException("unexpected outcome: " + outcome);
        });
    }

    // ------------------------------------------------------------- 共通の書き込み

    /**
     * テーブル1件の read-modify-write。{@code patch} は現在の {@link Table} を受け取り、
     * {@code meta} だけを差し替えた新しい {@link Table} を返す（{@code schema} には触れない）。
     */
    private String writeTable(Path dataDir, String tableId, Function<Table, Table> patch) {
        return retry(() -> {
            Path file = tables.tableFileOrNull(dataDir, tableId);
            if (file == null) {
                throw new McpTools.ToolException("Table \"" + tableId + "\" does not exist. "
                        + "Use erd_list_tables to see valid ids.");
            }
            String content = read(file);
            String baseHash = Hashes.sha256(content.getBytes(StandardCharsets.UTF_8));
            Table existing = parser.parseTable(content).value();
            Table patched = patch.apply(existing);

            TableService.Outcome outcome = tables.put(dataDir, tableId, patched, baseHash, false);
            if (outcome instanceof TableService.Ok ok) {
                return done("table", tableId, ok.writtenFiles(), ok.warnings());
            }
            if (outcome instanceof TableService.Stale) return null;
            if (outcome instanceof TableService.Invalid invalid) {
                throw new McpTools.ToolException(issues(invalid.errors()));
            }
            if (outcome instanceof TableService.NotFound) {
                throw new McpTools.ToolException("Table \"" + tableId + "\" does not exist.");
            }
            throw new IllegalStateException("unexpected outcome: " + outcome);
        });
    }

    /** 1回の試行。{@code null} を返したら STALE（読み直して再試行する）。 */
    private interface Attempt {
        String run();
    }

    private String retry(Attempt attempt) {
        for (int i = 0; i < ATTEMPTS; i++) {
            String result = attempt.run();
            if (result != null) return result;
        }
        throw new McpTools.ToolException("The file changed while writing (someone else — the ERForge "
                + "window, git pull, or another AI session — saved it at the same time). "
                + "Nothing was written. Read it again and retry.");
    }

    private String done(String what, String id, Map<String, String> written, List<Issue> warnings) {
        ObjectNode out = mapper.createObjectNode();
        out.put("ok", true);
        out.put(what, id);
        ArrayNode files = out.putArray("written");
        written.keySet().forEach(files::add);
        if (!warnings.isEmpty()) {
            ArrayNode w = out.putArray("warnings");
            warnings.forEach(i -> w.add(i.path() + ": " + i.message()));
        }
        try {
            return mapper.writeValueAsString(out);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    // ------------------------------------------------------------------ 小道具

    /**
     * 知らないキーは拒否する（INV-1 の実効的な担保）。物理情報（{@code columns[].type} 等）を
     * 混ぜられても黙って捨てず、「書けない」と伝える。
     */
    private static void rejectUnknownKeys(JsonNode node, Set<String> allowed, String where) {
        if (node == null || !node.isObject()) return;
        List<String> unknown = new ArrayList<>();
        node.fieldNames().forEachRemaining(k -> {
            if (!allowed.contains(k)) unknown.add(k);
        });
        if (unknown.isEmpty()) return;
        String prefix = where.isEmpty() ? "" : where + ": ";
        throw new McpTools.ToolException(prefix + "unsupported field(s) " + unknown
                + ". Physical information (column types, keys, indexes) comes from the database and "
                + "cannot be changed here. Allowed: " + String.join(", ", new java.util.TreeSet<>(allowed)));
    }

    /** 省略 = 現状維持、null = 消す、それ以外 = 置換。 */
    private static String patchText(JsonNode args, String field, String current) {
        if (args == null || !args.has(field)) return current;
        JsonNode v = args.get(field);
        if (v.isNull()) return null;
        String s = v.asText("").trim();
        return s.isEmpty() ? null : s;
    }

    private static List<String> patchStrings(JsonNode args, String field, List<String> current) {
        if (args == null || !args.has(field)) return current;
        JsonNode v = args.get(field);
        if (v.isNull()) return List.of();
        if (!v.isArray()) throw new McpTools.ToolException("\"" + field + "\" must be an array of strings.");
        return strings(v);
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        if (array != null && array.isArray()) array.forEach(n -> out.add(n.asText("")));
        return out;
    }

    private static String issues(List<Issue> errors) {
        StringBuilder sb = new StringBuilder("Validation failed:");
        for (Issue i : errors) sb.append("\n- ").append(i.path()).append(": ").append(i.message());
        return sb.toString();
    }

    private static String read(Path file) {
        try {
            return Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ------------------------------------------------------------ Q-06 バックアップ

    /**
     * MCP からの書き込み前のスナップショット（Q-06）。既存の {@link Backups}（K-11 と同一実装）を使う。
     *
     * <p>毎回取ると3世代がすぐ埋まって役に立たなくなるため、<b>サーバー起動後の最初の書き込み</b>と、
     * <b>前回から一定時間経過</b>したときだけ取る（ワークスペースごとに判定）。
     * バックアップに失敗しても書き込みは止めない — 最後の砦は Git であり、
     * ここは「Git を使っていない人」と「コミット前に大量に書かれた場合」の保険にすぎない。
     */
    static final class McpBackups {
        static final Duration INTERVAL = Duration.ofMinutes(10);
        private final Map<String, Instant> lastBackup = new ConcurrentHashMap<>();

        void beforeWrite(Path root, String workspaceId, Path dataDir) {
            Instant last = lastBackup.get(workspaceId);
            Instant now = Instant.now();
            if (last != null && Duration.between(last, now).compareTo(INTERVAL) < 0) return;
            try {
                Backups.create(WorkspaceStore.privateDir(root, workspaceId), dataDir);
                lastBackup.put(workspaceId, now);
            } catch (IOException | RuntimeException e) {
                System.err.println("MCP: backup before write failed for workspace \"" + workspaceId
                        + "\": " + e.getMessage());
            }
        }
    }
}
