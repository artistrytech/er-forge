package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.index.IndexGenerator;
import erd.core.index.IndexModel;
import erd.core.io.ProjectStore;
import erd.core.model.Column;
import erd.core.model.ColumnMeta;
import erd.core.model.DiagramPage;
import erd.core.model.DictionaryColumn;
import erd.core.model.ForeignKey;
import erd.core.model.IndexDef;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalUnique;
import erd.core.model.NodeLayout;
import erd.core.model.RelationMeta;
import erd.core.model.Table;
import erd.core.model.UniqueConstraint;
import erd.core.model.Workspace;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * MCP のツール実体（Q-02。読み取り）。
 *
 * <p><b>トランスポートを知らない。</b> JSON-RPC の層（{@link McpEndpoint}）から呼ばれるだけで、
 * ここには HTTP も JSON-RPC も出てこない。将来 stdio を足す場合もこのクラスは動かない。
 *
 * <p><b>キャッシュしない。</b> 毎回ディスクから読む。GUI からの保存直後に古い値を返さないためで、
 * ワークスペースあたり数十〜数百テーブルならこれで足りる。
 *
 * <p>ツールの説明文は<b>英語</b>である。LLM に向けたものであり、X-01 / X-02（UI の翻訳）の対象ではない。
 */
final class McpTools {

    /** 一覧系の既定件数。全部返すとクライアントのコンテキストを食い潰す。 */
    private static final int DEFAULT_LIMIT = 200;
    private static final int MAX_LIMIT = 1000;

    private final ObjectMapper mapper = new ObjectMapper();
    private final ProjectStore store = new ProjectStore();
    private final IndexGenerator indexGenerator = new IndexGenerator();
    private final WorkspaceStore workspaces = new WorkspaceStore();

    /** ツールの実行失敗（モデルが自力で直せるもの）。JSON-RPC error ではなく isError で返す。 */
    static final class ToolException extends RuntimeException {
        ToolException(String message) {
            super(message);
        }
    }

    // ----------------------------------------------------------- tools/list

    /**
     * ツール定義。書き込みツールは Q-01 の許可がオンのときだけ載せる（INV-6）。
     * 並びは固定する（クライアントがツール一覧をキャッシュできるように）。
     */
    ArrayNode definitions(boolean writeAllowed) {
        ArrayNode tools = mapper.createArrayNode();

        tools.add(tool("erd_list_workspaces",
                "List ERForge workspaces (one workspace = one database). "
                        + "Call this first when the project may contain more than one.",
                props -> { }));

        tools.add(tool("erd_list_tables",
                "List tables with their logical names, tags, column counts and the diagram pages "
                        + "they are placed on. Use this to get an overview before reading a table in full.",
                props -> {
                    props.set("workspace", str("Workspace id. Optional when only one exists."));
                    props.set("query", str("Case-insensitive substring matched against physical and logical names."));
                    props.set("tag", str("Only tables carrying this tag."));
                    props.set("diagram", str("Only tables placed on this diagram page id."));
                    props.set("limit", integer("Max rows (default " + DEFAULT_LIMIT + ")."));
                    props.set("offset", integer("Rows to skip (default 0)."));
                }));

        tools.add(tool("erd_get_table",
                "Get one table in full: columns with types, primary key, unique constraints, indexes, "
                        + "foreign keys, plus human-written logical names, notes and tags. "
                        + "Column logical names are resolved through the column dictionary and each one "
                        + "reports where it came from.",
                props -> {
                    props.set("workspace", str("Workspace id. Optional when only one exists."));
                    props.set("tableId", str("Fully qualified table id, e.g. \"public.orders\"."));
                }, "tableId"));

        tools.add(tool("erd_list_relations",
                "List relationships. kind is \"physical\" for real foreign keys and \"logical\" for "
                        + "human-defined ones that do not exist in the database. Cardinality is already resolved.",
                props -> {
                    props.set("workspace", str("Workspace id. Optional when only one exists."));
                    props.set("tableId", str("Only relations where this table is the source or the target."));
                }));

        tools.add(tool("erd_search",
                "Search tables, columns and notes by keyword.",
                props -> {
                    props.set("workspace", str("Workspace id. Optional when only one exists."));
                    props.set("query", str("Case-insensitive substring."));
                    props.set("target", enumStr("What to search. Default is all three.",
                            "table", "column", "note"));
                    props.set("limit", integer("Max hits (default " + DEFAULT_LIMIT + ")."));
                }, "query"));

        tools.add(tool("erd_list_diagrams",
                "List ER diagram pages with the number of tables placed on each.",
                props -> props.set("workspace", str("Workspace id. Optional when only one exists."))));

        tools.add(tool("erd_get_diagram",
                "Get one ER diagram page: which tables are placed on it and where.",
                props -> {
                    props.set("workspace", str("Workspace id. Optional when only one exists."));
                    props.set("diagramId", str("Diagram page id."));
                }, "diagramId"));

        tools.add(tool("erd_get_dictionary",
                "Get the column dictionary: logical names, tags and colors shared by every column "
                        + "with the same physical name across the whole workspace.",
                props -> props.set("workspace", str("Workspace id. Optional when only one exists."))));

        // 書き込みツール（Q-03 / Q-04）は後続フェーズで追加する。
        // 許可がオフのときは一覧にも出さないという規則だけ、ここで先に効かせておく
        if (writeAllowed) {
            // 追加時はここに載せる
        }
        return tools;
    }

    // ----------------------------------------------------------- tools/call

    /** ツールを実行してテキストを返す。失敗は {@link ToolException}（呼び出し側が isError にする）。 */
    String call(Path root, String name, JsonNode args) {
        return switch (name) {
            case "erd_list_workspaces" -> listWorkspaces(root);
            case "erd_list_tables" -> listTables(root, args);
            case "erd_get_table" -> getTable(root, args);
            case "erd_list_relations" -> listRelations(root, args);
            case "erd_search" -> search(root, args);
            case "erd_list_diagrams" -> listDiagrams(root, args);
            case "erd_get_diagram" -> getDiagram(root, args);
            case "erd_get_dictionary" -> getDictionary(root, args);
            default -> throw new IllegalArgumentException("Unknown tool: " + name);
        };
    }

    boolean isKnown(String name) {
        return name.startsWith("erd_") && definitions(true).findValuesAsText("name").contains(name);
    }

    // -------------------------------------------------------------- 各ツール

    private String listWorkspaces(Path root) {
        ArrayNode out = mapper.createArrayNode();
        for (Workspace ws : workspaces.list(root)) {
            ObjectNode node = out.addObject();
            node.put("id", ws.id());
            node.put("name", ws.name());
            Path dataDir = WorkspaceStore.dataDir(root, ws.id());
            if (Files.isRegularFile(dataDir.resolve("manifest.js"))) {
                try {
                    var manifest = store.readManifestOnly(dataDir);
                    node.put("tables", manifest.tables().size());
                    node.put("diagrams", manifest.diagrams().size());
                    node.put("schemaVersion", manifest.schemaVersion());
                } catch (RuntimeException e) {
                    node.put("error", "Could not read manifest.js: " + e.getMessage());
                }
            } else {
                node.put("tables", 0);
                node.put("empty", true);
            }
        }
        return json(mapper.createObjectNode().set("workspaces", out));
    }

    private String listTables(Path root, JsonNode args) {
        Loaded loaded = load(root, args);
        IndexModel index = loaded.index();
        String query = lower(text(args, "query"));
        String tag = text(args, "tag");
        String diagram = text(args, "diagram");

        List<IndexModel.TableEntry> hits = new ArrayList<>();
        for (IndexModel.TableEntry t : index.tables()) {
            if (!query.isEmpty()
                    && !lower(t.name()).contains(query)
                    && !lower(t.displayName()).contains(query)) {
                continue;
            }
            if (!tag.isEmpty() && !t.tags().contains(tag)) continue;
            if (!diagram.isEmpty() && !t.diagrams().contains(diagram)) continue;
            hits.add(t);
        }

        int offset = Math.max(0, intValue(args, "offset", 0));
        int limit = limit(args);
        ObjectNode out = mapper.createObjectNode();
        out.put("workspace", loaded.workspaceId());
        out.put("total", hits.size());
        ArrayNode rows = out.putArray("tables");
        for (int i = offset; i < Math.min(hits.size(), offset + limit); i++) {
            IndexModel.TableEntry t = hits.get(i);
            ObjectNode row = rows.addObject();
            row.put("id", t.id());
            row.put("name", t.name());
            if (t.displayName() != null) row.put("displayName", t.displayName());
            if (t.kind() != null) row.put("kind", t.kind());
            row.put("columns", t.columns());
            if (!t.tags().isEmpty()) row.set("tags", strings(t.tags()));
            if (t.color() != null) row.put("color", t.color());
            row.set("diagrams", strings(t.diagrams()));
        }
        note(out, hits.size(), offset, rows.size(), "tables");
        return json(out);
    }

    private String getTable(Path root, JsonNode args) {
        Loaded loaded = load(root, args);
        String id = required(args, "tableId");
        Table table = loaded.model().table(id).orElseThrow(() -> new ToolException(
                "Table \"" + id + "\" does not exist. " + tableHint(loaded)));

        ObjectNode out = mapper.createObjectNode();
        out.put("workspace", loaded.workspaceId());
        out.put("id", table.id());
        out.put("name", table.schema().name());
        out.put("schema", table.schema().schema());
        if (!table.schema().isTable()) out.put("kind", table.schema().kind());
        if (table.schema().comment() != null) out.put("comment", table.schema().comment());
        if (table.meta().displayName() != null) out.put("displayName", table.meta().displayName());
        if (table.meta().notes() != null) out.put("notes", table.meta().notes());
        if (!table.meta().tags().isEmpty()) out.set("tags", strings(table.meta().tags()));
        if (table.meta().color() != null) out.put("color", table.meta().color());

        ArrayNode columns = out.putArray("columns");
        for (Column c : table.schema().columns()) {
            ObjectNode col = columns.addObject();
            col.put("name", c.name());
            col.put("type", c.type());
            col.put("nullable", c.nullable());
            if (c.defaultValue() != null) col.put("default", c.defaultValue());
            if (c.autoIncrement()) col.put("autoIncrement", true);
            if (c.generated()) col.put("generated", true);
            if (c.comment() != null) col.put("comment", c.comment());

            // 論理名は「カラム個別 → 辞書 → 未設定」の順に解決し、どこ由来かを併記する。
            // モデルが「この論理名を上書きしてよいか」を判断できるようにするため
            ColumnMeta cm = table.meta().columns().get(c.name());
            DictionaryColumn dict = loaded.model().dictionary().columns().get(c.name());
            if (cm != null && cm.displayName() != null && !cm.displayName().isEmpty()) {
                col.put("displayName", cm.displayName());
                col.put("displayNameSource", "column");
            } else if (dict != null && dict.displayName() != null && !dict.displayName().isEmpty()) {
                col.put("displayName", dict.displayName());
                col.put("displayNameSource", "dictionary");
            }
            if (cm != null) {
                if (cm.notes() != null) col.put("notes", cm.notes());
                if (!cm.tags().isEmpty()) col.set("tags", strings(cm.tags()));
                if (cm.color() != null) col.put("color", cm.color());
            }
        }

        if (!table.schema().primaryKey().isEmpty()) {
            out.set("primaryKey", strings(table.schema().primaryKey()));
        }
        if (!table.schema().uniques().isEmpty()) {
            ArrayNode uniques = out.putArray("uniques");
            for (UniqueConstraint u : table.schema().uniques()) {
                uniques.addObject().put("name", u.name()).set("columns", strings(u.columns()));
            }
        }
        if (!table.schema().indexes().isEmpty()) {
            ArrayNode indexes = out.putArray("indexes");
            for (IndexDef i : table.schema().indexes()) {
                ObjectNode node = indexes.addObject();
                node.put("name", i.name());
                node.put("unique", i.unique());
                node.set("columns", strings(i.columns()));
            }
        }
        if (!table.schema().foreignKeys().isEmpty()) {
            ArrayNode fks = out.putArray("foreignKeys");
            for (ForeignKey fk : table.schema().foreignKeys()) {
                ObjectNode node = fks.addObject();
                node.put("name", fk.name());
                node.set("columns", strings(fk.columns()));
                node.put("references", fk.ref().table());
                node.set("referencedColumns", strings(fk.ref().columns()));
                node.put("onDelete", fk.onDelete());
                node.put("onUpdate", fk.onUpdate());
            }
        }
        if (!table.meta().logicalForeignKeys().isEmpty()) {
            ArrayNode lfks = out.putArray("logicalForeignKeys");
            for (LogicalForeignKey lfk : table.meta().logicalForeignKeys()) {
                ObjectNode node = lfks.addObject();
                node.put("name", lfk.name());
                node.set("columns", strings(lfk.columns()));
                node.put("references", lfk.ref().table());
                node.set("referencedColumns", strings(lfk.ref().columns()));
                if (lfk.notes() != null) node.put("notes", lfk.notes());
            }
        }
        if (!table.meta().logicalUniques().isEmpty()) {
            ArrayNode lus = out.putArray("logicalUniques");
            for (LogicalUnique lu : table.meta().logicalUniques()) {
                ObjectNode node = lus.addObject();
                node.put("name", lu.name());
                node.set("columns", strings(lu.columns()));
                if (lu.notes() != null) node.put("notes", lu.notes());
            }
        }
        if (!table.meta().relations().isEmpty()) {
            ObjectNode relations = out.putObject("relations");
            for (Map.Entry<String, RelationMeta> e : table.meta().relations().entrySet()) {
                ObjectNode node = relations.putObject(e.getKey());
                if (e.getValue().parent() != null) node.put("parent", e.getValue().parent());
                if (e.getValue().child() != null) node.put("child", e.getValue().child());
                if (e.getValue().notes() != null) node.put("notes", e.getValue().notes());
            }
        }
        ArrayNode pages = out.putArray("diagrams");
        for (DiagramPage page : loaded.model().diagramsSorted()) {
            if (page.nodes().containsKey(table.id())) pages.add(page.id());
        }
        return json(out);
    }

    private String listRelations(Path root, JsonNode args) {
        Loaded loaded = load(root, args);
        String tableId = text(args, "tableId");
        ObjectNode out = mapper.createObjectNode();
        out.put("workspace", loaded.workspaceId());
        ArrayNode rows = out.putArray("relations");
        for (IndexModel.RelationEntry r : loaded.index().relations()) {
            if (!tableId.isEmpty() && !r.from().equals(tableId) && !r.to().equals(tableId)) continue;
            ObjectNode node = rows.addObject();
            node.put("id", r.id());
            node.put("kind", r.kind());
            node.put("from", r.from());
            node.put("to", r.to());
            ArrayNode cols = node.putArray("columns");
            for (List<String> pair : r.columns()) {
                cols.addObject().put("from", pair.get(0)).put("to", pair.get(1));
            }
            if (r.cardinality() != null) {
                node.putObject("cardinality")
                        .put("parent", r.cardinality().parent())
                        .put("child", r.cardinality().child());
            }
            if (r.dangling()) node.put("dangling", true);
        }
        out.put("total", rows.size());
        return json(out);
    }

    private String search(Path root, JsonNode args) {
        Loaded loaded = load(root, args);
        String query = lower(required(args, "query"));
        String target = text(args, "target");
        boolean all = target.isEmpty();
        boolean wantTable = all || target.equals("table");
        boolean wantColumn = all || target.equals("column");
        boolean wantNote = all || target.equals("note");
        int limit = limit(args);

        ObjectNode out = mapper.createObjectNode();
        out.put("workspace", loaded.workspaceId());
        ArrayNode hits = out.putArray("hits");
        int total = 0;
        for (Table t : loaded.model().tablesSorted()) {
            if (wantTable && (lower(t.schema().name()).contains(query)
                    || lower(t.meta().displayName()).contains(query))) {
                total++;
                if (hits.size() < limit) {
                    hits.addObject().put("type", "table").put("table", t.id())
                            .put("name", t.schema().name())
                            .put("displayName", t.meta().displayName());
                }
            }
            if (wantColumn) {
                for (Column c : t.schema().columns()) {
                    ColumnMeta cm = t.meta().columns().get(c.name());
                    String columnDisplay = cm == null ? null : cm.displayName();
                    if (!lower(c.name()).contains(query) && !lower(columnDisplay).contains(query)) continue;
                    total++;
                    if (hits.size() < limit) {
                        hits.addObject().put("type", "column").put("table", t.id())
                                .put("column", c.name()).put("displayName", columnDisplay);
                    }
                }
            }
            if (wantNote) {
                if (lower(t.meta().notes()).contains(query)) {
                    total++;
                    if (hits.size() < limit) {
                        hits.addObject().put("type", "note").put("table", t.id())
                                .put("notes", t.meta().notes());
                    }
                }
                for (Map.Entry<String, ColumnMeta> e : t.meta().columns().entrySet()) {
                    if (!lower(e.getValue().notes()).contains(query)) continue;
                    total++;
                    if (hits.size() < limit) {
                        hits.addObject().put("type", "note").put("table", t.id())
                                .put("column", e.getKey()).put("notes", e.getValue().notes());
                    }
                }
            }
        }
        out.put("total", total);
        note(out, total, 0, hits.size(), "hits");
        return json(out);
    }

    private String listDiagrams(Path root, JsonNode args) {
        Loaded loaded = load(root, args);
        ObjectNode out = mapper.createObjectNode();
        out.put("workspace", loaded.workspaceId());
        ArrayNode rows = out.putArray("diagrams");
        for (DiagramPage page : loaded.model().diagramsSorted()) {
            rows.addObject()
                    .put("id", page.id())
                    .put("title", page.title())
                    .put("order", page.order())
                    .put("tables", page.nodes().size());
        }
        return json(out);
    }

    private String getDiagram(Path root, JsonNode args) {
        Loaded loaded = load(root, args);
        String id = required(args, "diagramId");
        DiagramPage page = loaded.model().diagrams().stream()
                .filter(p -> p.id().equals(id)).findFirst()
                .orElseThrow(() -> new ToolException("Diagram page \"" + id + "\" does not exist. "
                        + "Existing page ids: " + ids(loaded.model().diagramsSorted().stream()
                        .map(DiagramPage::id).toList())));
        ObjectNode out = mapper.createObjectNode();
        out.put("workspace", loaded.workspaceId());
        out.put("id", page.id());
        out.put("title", page.title());
        out.put("order", page.order());
        ArrayNode nodes = out.putArray("nodes");
        for (Map.Entry<String, NodeLayout> e : page.nodes().entrySet()) {
            ObjectNode node = nodes.addObject();
            node.put("table", e.getKey());
            if (e.getValue().pos() != null) {
                node.putArray("pos").add(e.getValue().pos().x()).add(e.getValue().pos().y());
            }
            if (e.getValue().w() != null) node.put("w", e.getValue().w());
        }
        ArrayNode edges = out.putArray("edges");
        page.edges().keySet().forEach(edges::add);
        return json(out);
    }

    private String getDictionary(Path root, JsonNode args) {
        Loaded loaded = load(root, args);
        ObjectNode out = mapper.createObjectNode();
        out.put("workspace", loaded.workspaceId());
        ArrayNode rows = out.putArray("columns");
        for (Map.Entry<String, DictionaryColumn> e : loaded.model().dictionary().columns().entrySet()) {
            ObjectNode node = rows.addObject();
            node.put("column", e.getKey());
            if (e.getValue().displayName() != null) node.put("displayName", e.getValue().displayName());
            if (!e.getValue().tags().isEmpty()) node.set("tags", strings(e.getValue().tags()));
            if (e.getValue().color() != null) node.put("color", e.getValue().color());
        }
        return json(out);
    }

    // -------------------------------------------------------------- 読み込み

    private record Loaded(String workspaceId, erd.core.model.ProjectModel model, IndexModel index) { }

    /**
     * ワークスペースを決めて {@code data/**} を読む。
     *
     * <p><b>省略時に黙って先頭を選ばない。</b> 1つしか無ければそれを使い、複数あるなら
     * 「どれか」を明示させる（別の DB のデータを書き換える事故を防ぐ）。
     */
    private Loaded load(Path root, JsonNode args) {
        String id = text(args, "workspace");
        List<String> available = WorkspaceStore.scan(root);
        if (id.isEmpty()) {
            if (available.isEmpty()) {
                throw new ToolException("This project has no workspace yet. "
                        + "Create one in the ERForge window first.");
            }
            if (available.size() > 1) {
                throw new ToolException("More than one workspace exists; pass \"workspace\". "
                        + "Available: " + ids(available));
            }
            id = available.get(0);
        } else if (!WorkspaceStore.exists(root, id)) {
            throw new ToolException("Workspace \"" + id + "\" does not exist. Available: " + ids(available));
        }
        Path dataDir = WorkspaceStore.dataDir(root, id);
        if (!Files.isRegularFile(dataDir.resolve("manifest.js"))) {
            throw new ToolException("Workspace \"" + id + "\" has no data yet "
                    + "(no manifest.js). Import a schema in the ERForge window first.");
        }
        ProjectStore.LoadResult loaded = store.read(dataDir);
        IndexModel index = indexGenerator.generate(loaded.model().tables(), loaded.model().diagrams());
        return new Loaded(id, loaded.model(), index);
    }

    // ---------------------------------------------------------------- 小道具

    private String tableHint(Loaded loaded) {
        List<String> names = loaded.index().tables().stream().map(IndexModel.TableEntry::id).limit(20).toList();
        return "Use erd_list_tables to see valid ids. First ones: " + ids(names);
    }

    private static String ids(List<String> values) {
        return values.isEmpty() ? "(none)" : String.join(", ", values);
    }

    /** 打ち切ったことを必ず伝える（モデルが全件だと誤認しないように）。 */
    private void note(ObjectNode out, int total, int offset, int shown, String unit) {
        if (offset > 0 || shown < total) {
            out.put("note", "showing " + shown + " of " + total + " " + unit
                    + (offset > 0 ? " (offset " + offset + ")" : "")
                    + ". Use limit/offset to page through the rest.");
        }
    }

    private int limit(JsonNode args) {
        return Math.min(MAX_LIMIT, Math.max(1, intValue(args, "limit", DEFAULT_LIMIT)));
    }

    private static String text(JsonNode args, String field) {
        JsonNode node = args == null ? null : args.get(field);
        return node == null || node.isNull() ? "" : node.asText("").trim();
    }

    private static String required(JsonNode args, String field) {
        String value = text(args, field);
        if (value.isEmpty()) throw new ToolException("\"" + field + "\" is required.");
        return value;
    }

    private static int intValue(JsonNode args, String field, int fallback) {
        JsonNode node = args == null ? null : args.get(field);
        return node == null || !node.canConvertToInt() ? fallback : node.asInt();
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }

    private ArrayNode strings(List<String> values) {
        ArrayNode array = mapper.createArrayNode();
        values.forEach(array::add);
        return array;
    }

    private String json(JsonNode node) {
        try {
            return mapper.writeValueAsString(node);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    // ------------------------------------------------------- ツール定義の組み立て

    private interface Props {
        void fill(ObjectNode properties);
    }

    private ObjectNode tool(String name, String description, Props props, String... required) {
        ObjectNode tool = mapper.createObjectNode();
        tool.put("name", name);
        tool.put("description", description);
        ObjectNode schema = tool.putObject("inputSchema");
        schema.put("type", "object");
        ObjectNode properties = schema.putObject("properties");
        props.fill(properties);
        if (required.length > 0) {
            ArrayNode req = schema.putArray("required");
            for (String r : required) req.add(r);
        }
        schema.put("additionalProperties", false);
        return tool;
    }

    private ObjectNode str(String description) {
        return mapper.createObjectNode().put("type", "string").put("description", description);
    }

    private ObjectNode integer(String description) {
        return mapper.createObjectNode().put("type", "integer").put("description", description);
    }

    private ObjectNode enumStr(String description, String... values) {
        ObjectNode node = str(description);
        ArrayNode allowed = node.putArray("enum");
        for (String v : values) allowed.add(v);
        return node;
    }
}
