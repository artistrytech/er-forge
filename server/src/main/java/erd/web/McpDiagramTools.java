package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.index.IndexGenerator;
import erd.core.index.IndexModel;
import erd.core.io.DataFileParser;
import erd.core.io.ProjectStore;
import erd.core.model.DiagramPage;
import erd.core.model.NodeLayout;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.layout.AutoLayout;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * MCP の書き込みツール（Q-04 / Q-05。ER図の構成）。
 *
 * <p><b>座標を AI に書かせない（Q-05）。</b> LLM は「どのテーブルを同じページに置くか」という
 * 意味的な判断は得意だが、重なりのない座標を出すのは苦手で、1テーブル1呼び出しにすると
 * ツール呼び出しを浪費する。{@code erd_place_tables} はテーブル ID の集合だけを受け取り、
 * 座標は同一プロセスに居る {@link AutoLayout}（Eclipse ELK）が計算する。
 * これは既存 Web サーバーに相乗りする方式（設計書 §8.8）を選んだから可能になった。
 *
 * <p>書き込みは {@link DiagramService} をそのまま通す（INV-4）。ページの追加・削除・改名・
 * ノードの配置はいずれも GUI と同じ経路であり、{@code manifest.js} / {@code index.js} の再生成も
 * そちらで行われる。
 */
final class McpDiagramTools {

    static final List<String> NAMES = List.of(
            "erd_create_diagram",
            "erd_update_diagram",
            "erd_delete_diagram",
            "erd_place_tables",
            "erd_auto_layout",
            "erd_set_node_positions");

    /** {@link DiagramService} と同じ規則。ここでも先に弾いて、分かりやすい文言を返す。 */
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9._-]+");

    /** ELK の結果（原点 0,0）をページに置くときの余白。 */
    private static final int MARGIN = 80;
    /** {@code layout: "keep"} で新規ノードを既存の下に並べるときの間隔と折り返し幅。 */
    private static final int GRID_X = 260;
    private static final int GRID_Y = 96;
    private static final int GRID_WRAP = 1600;
    private static final int NODE_H = 44;

    private final ObjectMapper mapper = new ObjectMapper();
    private final DataFileParser parser = new DataFileParser();
    private final ProjectStore store = new ProjectStore();
    private final IndexGenerator indexGenerator = new IndexGenerator();
    private final DiagramService diagrams = new DiagramService();
    private final AutoLayout autoLayout = new AutoLayout();

    // ----------------------------------------------------------- tools/list

    void define(ArrayNode tools, McpTools.Defs defs) {
        tools.add(defs.tool("erd_create_diagram",
                "Create an empty ER diagram page. Then call erd_place_tables to put tables on it.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("id", defs.str("Page id: letters, digits, dots, underscores, hyphens. E.g. \"orders\"."));
                    props.set("title", defs.str("Page title shown to people, e.g. \"受注\"."));
                    props.set("order", defs.integer("Display order. Defaults to last."));
                }, "id", "title"));

        tools.add(defs.tool("erd_update_diagram",
                "Rename a page or change its display order.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("diagramId", defs.str("Page id."));
                    props.set("title", defs.str("New title."));
                    props.set("order", defs.integer("New display order."));
                }, "diagramId"));

        tools.add(defs.tool("erd_delete_diagram",
                "Delete a page. Table definitions are not affected; only the page and its placement go away.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("diagramId", defs.str("Page id."));
                }, "diagramId"));

        tools.add(defs.tool("erd_place_tables",
                "Put tables on a page and/or take them off, in one call. Positions are computed by the "
                        + "server's automatic layout — you never need to think about coordinates. "
                        + "Pass every table you want on the page at once rather than one per call.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("diagramId", defs.str("Page id (create it first with erd_create_diagram)."));
                    props.set("add", defs.strArray("Table ids to place, e.g. [\"public.orders\", \"public.order_items\"]."));
                    props.set("remove", defs.strArray("Table ids to take off this page."));
                    props.set("layout", defs.enumStr(
                            "\"auto\" (default) re-lays out the whole page so relationships read left to right. "
                                    + "\"keep\" leaves existing tables where they are and puts new ones below.",
                            "auto", "keep"));
                }, "diagramId"));

        tools.add(defs.tool("erd_auto_layout",
                "Re-run the automatic layout on a page (same as erd_place_tables with layout \"auto\" and nothing to add).",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("diagramId", defs.str("Page id."));
                }, "diagramId"));

        tools.add(defs.tool("erd_set_node_positions",
                "Set explicit coordinates for tables already on a page. Prefer erd_place_tables; "
                        + "only use this to fine-tune a layout the automatic one got wrong.",
                props -> {
                    props.set("workspace", defs.str("Workspace id. Optional when only one exists."));
                    props.set("diagramId", defs.str("Page id."));
                    ObjectNode nodes = mapper.createObjectNode().put("type", "object");
                    nodes.put("description", "Map of table id to [x, y] in pixels.");
                    ObjectNode pos = mapper.createObjectNode().put("type", "array");
                    pos.putObject("items").put("type", "number");
                    pos.put("minItems", 2).put("maxItems", 2);
                    nodes.set("additionalProperties", pos);
                    props.set("nodes", nodes);
                }, "diagramId", "nodes"));
    }

    // ----------------------------------------------------------- tools/call

    String call(Path dataDir, String name, JsonNode args) {
        return switch (name) {
            case "erd_create_diagram" -> create(dataDir, args);
            case "erd_update_diagram" -> update(dataDir, args);
            case "erd_delete_diagram" -> delete(dataDir, args);
            case "erd_place_tables" -> place(dataDir, args, false);
            case "erd_auto_layout" -> place(dataDir, args, true);
            case "erd_set_node_positions" -> setPositions(dataDir, args);
            default -> throw new IllegalArgumentException("Unknown tool: " + name);
        };
    }

    // ------------------------------------------------------------- ページ操作

    private String create(Path dataDir, JsonNode args) {
        McpWriteTools.rejectUnknownKeys(args, Set.of("workspace", "id", "title", "order"), "");
        String id = McpTools.required(args, "id");
        if (!SAFE_ID.matcher(id).matches()) {
            throw new McpTools.ToolException("Page id \"" + id + "\" is invalid. Use letters, digits, dots, "
                    + "underscores and hyphens only (no spaces). " + existingPages(dataDir));
        }
        ObjectNode body = mapper.createObjectNode();
        body.put("id", id);
        body.put("title", McpTools.required(args, "title"));
        if (args.hasNonNull("order") && args.get("order").canConvertToInt()) {
            body.put("order", args.get("order").asInt());
        }
        return outcome(dataDir, id, diagrams.create(dataDir, body), "created");
    }

    private String update(Path dataDir, JsonNode args) {
        McpWriteTools.rejectUnknownKeys(args, Set.of("workspace", "diagramId", "title", "order"), "");
        String id = McpTools.required(args, "diagramId");
        if (!args.has("title") && !args.has("order")) {
            throw new McpTools.ToolException("Pass \"title\" and/or \"order\".");
        }
        return McpWriteTools.retry(() -> {
            Loaded page = pageOrThrow(dataDir, id);
            ObjectNode body = mapper.createObjectNode().put("baseHash", page.baseHash());
            if (args.has("title")) body.put("title", McpTools.text(args, "title"));
            if (args.hasNonNull("order") && args.get("order").canConvertToInt()) {
                body.put("order", args.get("order").asInt());
            }
            return outcomeOrNull(dataDir, id, diagrams.patch(dataDir, id, body), "updated");
        });
    }

    private String delete(Path dataDir, JsonNode args) {
        McpWriteTools.rejectUnknownKeys(args, Set.of("workspace", "diagramId"), "");
        String id = McpTools.required(args, "diagramId");
        return McpWriteTools.retry(() -> {
            Loaded page = pageOrThrow(dataDir, id);
            ObjectNode body = mapper.createObjectNode().put("baseHash", page.baseHash());
            return outcomeOrNull(dataDir, id, diagrams.delete(dataDir, id, body), "deleted");
        });
    }

    // --------------------------------------------------------- 配置（Q-05）

    /**
     * ページ上のテーブル集合を一括更新し、座標はサーバーが決める。
     *
     * @param relayoutOnly {@code erd_auto_layout}（add / remove を受けず、常に auto）
     */
    private String place(Path dataDir, JsonNode args, boolean relayoutOnly) {
        McpWriteTools.rejectUnknownKeys(args, relayoutOnly
                ? Set.of("workspace", "diagramId")
                : Set.of("workspace", "diagramId", "add", "remove", "layout"), "");
        String id = McpTools.required(args, "diagramId");
        List<String> add = relayoutOnly ? List.of() : McpWriteTools.strings(args.path("add"));
        List<String> remove = relayoutOnly ? List.of() : McpWriteTools.strings(args.path("remove"));
        String layout = relayoutOnly ? "auto" : McpTools.text(args, "layout");
        if (layout.isEmpty()) layout = "auto";
        if (!layout.equals("auto") && !layout.equals("keep")) {
            throw new McpTools.ToolException("\"layout\" must be \"auto\" or \"keep\".");
        }
        if (!relayoutOnly && add.isEmpty() && remove.isEmpty()) {
            throw new McpTools.ToolException("Pass \"add\" and/or \"remove\" (table ids). "
                    + "To only re-run the layout, use erd_auto_layout.");
        }
        final String layoutMode = layout;

        return McpWriteTools.retry(() -> {
            ProjectStore.LoadResult loaded = store.read(dataDir);
            ProjectModel model = loaded.model();
            Loaded page = pageOrThrow(dataDir, id);

            // 置こうとしているテーブルが本当に存在するか（無ければ候補を添えて拒否）
            Map<String, Table> byId = new LinkedHashMap<>();
            model.tablesSorted().forEach(t -> byId.put(t.id(), t));
            List<String> unknown = add.stream().filter(t -> !byId.containsKey(t)).toList();
            if (!unknown.isEmpty()) {
                throw new McpTools.ToolException("Unknown table id(s): " + unknown
                        + ". Use erd_list_tables to see valid ids.");
            }

            // 最終的なノード集合（ID 順に固定して、レイアウトを決定論的にする）
            Set<String> finalIds = new TreeSet<>(page.page().nodes().keySet());
            remove.forEach(finalIds::remove);
            finalIds.addAll(add);

            ObjectNode body = mapper.createObjectNode().put("baseHash", page.baseHash());
            ObjectNode nodes = body.putObject("nodes");
            for (String r : remove) {
                if (page.page().nodes().containsKey(r)) nodes.putNull(r);
            }

            Map<String, int[]> positions = layoutMode.equals("auto")
                    ? layoutAll(finalIds, byId, page.page(), model)
                    : placeBelow(finalIds, page.page());
            positions.forEach((tableId, pos) -> {
                ObjectNode n = nodes.putObject(tableId);
                n.putArray("pos").add(pos[0]).add(pos[1]);
            });

            DiagramService.Outcome outcome = diagrams.patch(dataDir, id, body);
            String result = outcomeOrNull(dataDir, id, outcome, "placed");
            if (result == null) return null;
            ObjectNode out = (ObjectNode) parse(result);
            ArrayNode placed = out.putArray("tables");
            finalIds.forEach(placed::add);
            out.put("layout", layoutMode);
            return out.toString();
        });
    }

    /** ページ全体を ELK で並べ直す。エッジはページ内に閉じたリレーションだけ。 */
    private Map<String, int[]> layoutAll(Set<String> ids, Map<String, Table> byId,
                                         DiagramPage page, ProjectModel model) {
        List<AutoLayout.Node> nodes = new ArrayList<>();
        for (String tableId : ids) {
            NodeLayout existing = page.nodes().get(tableId);
            double w = existing != null && existing.w() != null ? existing.w() : estimateWidth(byId.get(tableId));
            nodes.add(new AutoLayout.Node(tableId, w, NODE_H));
        }
        IndexModel index = indexGenerator.generate(model.tables(), model.diagrams());
        List<AutoLayout.Edge> edges = new ArrayList<>();
        for (IndexModel.RelationEntry r : index.relations()) {
            if (!r.dangling() && ids.contains(r.from()) && ids.contains(r.to())) {
                edges.add(new AutoLayout.Edge(r.from(), r.to()));
            }
        }
        Map<String, int[]> out = new LinkedHashMap<>();
        autoLayout.layout(nodes, edges).forEach((tableId, pos) ->
                out.put(tableId, new int[] {pos[0] + MARGIN, pos[1] + MARGIN}));
        return out;
    }

    /** {@code keep}: 既存はそのまま。新規だけを既存の下に、ID 順で左から並べる。 */
    private Map<String, int[]> placeBelow(Set<String> ids, DiagramPage page) {
        int bottom = MARGIN;
        for (NodeLayout n : page.nodes().values()) {
            if (n.pos() != null) bottom = Math.max(bottom, n.pos().y() + NODE_H);
        }
        Map<String, int[]> out = new LinkedHashMap<>();
        int x = MARGIN;
        int y = bottom + GRID_Y;
        for (String tableId : ids) {
            if (page.nodes().containsKey(tableId)) continue;   // 既存は動かさない
            out.put(tableId, new int[] {x, y});
            x += GRID_X;
            if (x > GRID_WRAP) {
                x = MARGIN;
                y += GRID_Y;
            }
        }
        return out;
    }

    /**
     * ノード幅の見積もり。ビューアは実測値を ELK に渡すが、MCP にはブラウザが無い。
     * 論理名（全角）と物理名の長いほうから概算する。多少ずれても、人が GUI で整えれば済む。
     */
    private static double estimateWidth(Table table) {
        int len = table.schema().name().length();
        String displayName = table.meta().displayName();
        if (displayName != null) len = Math.max(len, displayName.length());
        return Math.min(420, Math.max(180, 14 * len + 48));
    }

    private String setPositions(Path dataDir, JsonNode args) {
        McpWriteTools.rejectUnknownKeys(args, Set.of("workspace", "diagramId", "nodes"), "");
        String id = McpTools.required(args, "diagramId");
        JsonNode nodesArg = args.path("nodes");
        if (!nodesArg.isObject() || nodesArg.isEmpty()) {
            throw new McpTools.ToolException("\"nodes\" must be an object of table id -> [x, y].");
        }
        return McpWriteTools.retry(() -> {
            Loaded page = pageOrThrow(dataDir, id);
            ObjectNode body = mapper.createObjectNode().put("baseHash", page.baseHash());
            ObjectNode nodes = body.putObject("nodes");
            List<String> notOnPage = new ArrayList<>();
            for (Iterator<String> it = nodesArg.fieldNames(); it.hasNext(); ) {
                String tableId = it.next();
                JsonNode pos = nodesArg.get(tableId);
                if (!page.page().nodes().containsKey(tableId)) {
                    notOnPage.add(tableId);
                    continue;
                }
                if (!pos.isArray() || pos.size() != 2 || !pos.get(0).isNumber() || !pos.get(1).isNumber()) {
                    throw new McpTools.ToolException("Position for \"" + tableId + "\" must be [x, y].");
                }
                nodes.putObject(tableId).putArray("pos").add(pos.get(0).asInt()).add(pos.get(1).asInt());
            }
            if (!notOnPage.isEmpty()) {
                throw new McpTools.ToolException("Not on page \"" + id + "\": " + notOnPage
                        + ". Add them with erd_place_tables first.");
            }
            return outcomeOrNull(dataDir, id, diagrams.patch(dataDir, id, body), "moved");
        });
    }

    // ---------------------------------------------------------------- 小道具

    private record Loaded(DiagramPage page, String baseHash) { }

    private Loaded pageOrThrow(Path dataDir, String id) {
        if (!SAFE_ID.matcher(id).matches()) {
            throw new McpTools.ToolException("Diagram page \"" + id + "\" does not exist. " + existingPages(dataDir));
        }
        Path file = dataDir.resolve("diagrams/" + id + ".js");
        if (!Files.isRegularFile(file)) {
            throw new McpTools.ToolException("Diagram page \"" + id + "\" does not exist. " + existingPages(dataDir));
        }
        try {
            String content = Files.readString(file, StandardCharsets.UTF_8);
            return new Loaded(parser.parseDiagram(content).value(),
                    Hashes.sha256(content.getBytes(StandardCharsets.UTF_8)));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private String existingPages(Path dataDir) {
        try {
            List<String> ids = store.readManifestOnly(dataDir).diagrams().stream()
                    .map(d -> d.id()).sorted().toList();
            return "Existing page ids: " + (ids.isEmpty() ? "(none)" : String.join(", ", ids));
        } catch (RuntimeException e) {
            return "";
        }
    }

    /** 作成のように STALE が無い操作。 */
    private String outcome(Path dataDir, String id, DiagramService.Outcome outcome, String verb) {
        String result = outcomeOrNull(dataDir, id, outcome, verb);
        if (result == null) throw new IllegalStateException("unexpected STALE on " + verb);
        return result;
    }

    /** {@code null} = STALE（呼び出し側が読み直して再試行する）。 */
    private String outcomeOrNull(Path dataDir, String id, DiagramService.Outcome outcome, String verb) {
        if (outcome instanceof DiagramService.Ok ok) {
            ObjectNode out = mapper.createObjectNode();
            out.put("ok", true);
            out.put("diagram", id);
            out.put("action", verb);
            ArrayNode files = out.putArray("written");
            ok.writtenFiles().keySet().forEach(files::add);
            return out.toString();
        }
        if (outcome instanceof DiagramService.Stale) return null;
        if (outcome instanceof DiagramService.NotFound) {
            throw new McpTools.ToolException("Diagram page \"" + id + "\" does not exist. " + existingPages(dataDir));
        }
        if (outcome instanceof DiagramService.Duplicate) {
            throw new McpTools.ToolException("Diagram page \"" + id + "\" already exists. "
                    + "Use erd_place_tables to add tables to it, or pick another id. " + existingPages(dataDir));
        }
        if (outcome instanceof DiagramService.Invalid invalid) {
            throw new McpTools.ToolException(invalid.message());
        }
        throw new IllegalStateException("unexpected outcome: " + outcome);
    }

    private JsonNode parse(String json) {
        try {
            return mapper.readTree(json);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
