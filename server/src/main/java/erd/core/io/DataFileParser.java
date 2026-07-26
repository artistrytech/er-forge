package erd.core.io;

import com.fasterxml.jackson.core.json.JsonReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.model.Column;
import erd.core.model.ColumnMeta;
import erd.core.model.DiagramPage;
import erd.core.model.Dictionary;
import erd.core.model.DriverConfig;
import erd.core.model.EdgeLayout;
import erd.core.model.ForeignKey;
import erd.core.model.IndexDef;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalType;
import erd.core.model.LogicalUnique;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
import erd.core.model.ProjectConfig;
import erd.core.model.Ref;
import erd.core.model.RelationMeta;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import erd.core.model.UniqueConstraint;
import erd.core.model.Workspace;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * データファイルのパーサ（Phase0 詳細設計 §3）。
 *
 * <p>ラッパ（ERD.table( … );）を剥がし、Jackson（緩和フラグ付き）でオブジェクトリテラルを
 * パースする。未知キーは捨てずに unknown へ退避し、プリンタが書き戻す（V-4。前方互換）。
 */
public final class DataFileParser {

    private static final ObjectMapper MAPPER = JsonMapper.builder()
            .enable(JsonReadFeature.ALLOW_UNQUOTED_FIELD_NAMES)
            .enable(JsonReadFeature.ALLOW_SINGLE_QUOTES)
            .enable(JsonReadFeature.ALLOW_TRAILING_COMMA)
            .enable(JsonReadFeature.ALLOW_JAVA_COMMENTS)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();

    private static final Pattern WRAPPER =
            Pattern.compile("\\A\\s*ERD\\.([A-Za-z]+)\\(\\s*(.*)\\s*\\)\\s*;\\s*\\z", Pattern.DOTALL);

    // ---------------------------------------------------------------- entry

    public Parsed<Table> parseTable(String content) {
        List<String> warnings = new ArrayList<>();
        Obj root = new Obj(stripWrapper(content, "table"));

        // V-1: 必須キー
        String id = root.requiredText("id");
        String name = root.requiredText("name");
        JsonNode columnsNode = root.node("columns");
        if (columnsNode == null || !columnsNode.isArray()) {
            throw new DataFileException("required key missing or not an array: columns");
        }

        String schema = root.text("schema");
        String comment = root.text("comment");

        List<Column> columns = new ArrayList<>();
        for (JsonNode c : columnsNode) {
            columns.add(readColumn(c, warnings));
        }

        List<String> primaryKey = root.textArray("primaryKey");

        List<UniqueConstraint> uniques = new ArrayList<>();
        for (JsonNode u : root.array("uniques")) {
            Obj o = new Obj(asObject(u, "uniques[]"));
            uniques.add(new UniqueConstraint(o.requiredText("name"), o.textArray("columns")));
        }

        List<IndexDef> indexes = new ArrayList<>();
        for (JsonNode ix : root.array("indexes")) {
            Obj o = new Obj(asObject(ix, "indexes[]"));
            indexes.add(new IndexDef(o.requiredText("name"), o.textArray("columns"), o.bool("unique", false)));
        }

        List<ForeignKey> foreignKeys = new ArrayList<>();
        for (JsonNode fk : root.array("foreignKeys")) {
            Obj o = new Obj(asObject(fk, "foreignKeys[]"));
            foreignKeys.add(new ForeignKey(
                    o.requiredText("name"),
                    o.textArray("columns"),
                    readRef(o.node("ref")),
                    o.text("onDelete"),
                    o.text("onUpdate")));
        }

        Map<String, JsonNode> dialect = objectAsMap(root.node("dialect"));
        TableMeta meta = readMeta(root.node("meta"), warnings);
        Map<String, JsonNode> unknown = root.rest();

        // V-3: id と schema.name の一致
        if (schema != null && !id.equals(schema + "." + name)) {
            warnings.add("id \"" + id + "\" does not match schema.name \"" + schema + "." + name + "\" (id wins)");
        }

        TableSchema tableSchema = new TableSchema(
                name, schema, comment, columns, primaryKey, uniques, indexes, foreignKeys, dialect);
        return new Parsed<>(new Table(id, tableSchema, meta, unknown), warnings);
    }

    public Parsed<DiagramPage> parseDiagram(String content) {
        List<String> warnings = new ArrayList<>();
        Obj root = new Obj(stripWrapper(content, "diagram"));

        String id = root.requiredText("id");
        String title = root.requiredText("title");
        int order = root.integer("order", 0);

        Map<String, NodeLayout> nodes = new LinkedHashMap<>();
        JsonNode nodesNode = root.node("nodes");
        if (nodesNode != null) {
            nodesNode.fields().forEachRemaining(e -> {
                Obj o = new Obj(asObject(e.getValue(), "nodes." + e.getKey()));
                Point pos = readPoint(o.node("pos"), "nodes." + e.getKey() + ".pos");
                Integer w = o.integerOrNull("w");
                nodes.put(e.getKey(), new NodeLayout(pos, w, o.rest()));
            });
        }

        Map<String, EdgeLayout> edges = new LinkedHashMap<>();
        JsonNode edgesNode = root.node("edges");
        if (edgesNode != null) {
            edgesNode.fields().forEachRemaining(e -> {
                Obj o = new Obj(asObject(e.getValue(), "edges." + e.getKey()));
                List<Point> waypoints = new ArrayList<>();
                JsonNode wp = o.node("waypoints");
                if (wp != null) {
                    for (JsonNode pt : wp) {
                        waypoints.add(readPoint(pt, "edges." + e.getKey() + ".waypoints[]"));
                    }
                }
                edges.put(e.getKey(), new EdgeLayout(waypoints, o.rest()));
            });
        }

        return new Parsed<>(new DiagramPage(id, title, order, nodes, edges, root.rest()), warnings);
    }

    public Parsed<Manifest> parseManifest(String content) {
        List<String> warnings = new ArrayList<>();
        Obj root = new Obj(stripWrapper(content, "manifest"));

        int schemaVersion = root.integer("schemaVersion", -1);
        if (schemaVersion < 0) {
            throw new DataFileException("required key missing: schemaVersion");
        }
        String generatedAt = root.text("generatedAt");

        Manifest.Source source = null;
        JsonNode sourceNode = root.node("source");
        if (sourceNode != null && sourceNode.isObject()) {
            source = new Manifest.Source(
                    textOrNull(sourceNode.get("product")), textOrNull(sourceNode.get("version")));
        }

        String config = root.text("config");
        String dictionary = root.text("dictionary");

        Map<String, String> tables = new LinkedHashMap<>();
        JsonNode tablesNode = root.node("tables");
        if (tablesNode != null) {
            tablesNode.fields().forEachRemaining(e -> tables.put(e.getKey(), e.getValue().asText()));
        }

        List<Manifest.DiagramRef> diagrams = new ArrayList<>();
        for (JsonNode d : root.array("diagrams")) {
            Obj o = new Obj(asObject(d, "diagrams[]"));
            diagrams.add(new Manifest.DiagramRef(
                    o.requiredText("id"), o.requiredText("file"),
                    o.text("title"), o.integer("order", 0)));
        }

        return new Parsed<>(new Manifest(schemaVersion, generatedAt, source, config, dictionary,
                tables, diagrams, root.rest()), warnings);
    }

    public Parsed<ProjectConfig> parseConfig(String content) {
        Obj root = new Obj(stripWrapper(content, "config"));
        List<String> ignoreTables = root.textArray("ignoreTables");
        DriverConfig drivers = DriverConfig.EMPTY;
        JsonNode dn = root.node("drivers");
        if (dn != null && dn.isObject()) {
            Obj d = new Obj((ObjectNode) dn);
            drivers = new DriverConfig(d.text("mavenRepository"), d.textArray("artifacts"));
        }
        return new Parsed<>(new ProjectConfig(ignoreTables, drivers, root.rest()), List.of());
    }

    /**
     * {@code erd/workspaces.js}（ワークスペースの索引。ツール生成物）。
     * 壊れていても起動を止めないよう、要素の欠損は黙って捨てる（存在の正はフォルダ走査）。
     */
    public Parsed<List<Workspace>> parseWorkspaces(String content) {
        Obj root = new Obj(stripWrapper(content, "workspaces"));
        List<Workspace> out = new ArrayList<>();
        for (JsonNode w : root.array("workspaces")) {
            if (!w.isObject()) continue;
            Obj o = new Obj((ObjectNode) w);
            String id = o.text("id");
            String name = o.text("name");
            if (id == null || id.isEmpty() || !Workspace.isValidId(id)) continue;
            out.add(new Workspace(id, name == null || name.isEmpty() ? id : name));
        }
        return new Parsed<>(out, List.of());
    }

    public Parsed<Dictionary> parseDictionary(String content) {
        Obj root = new Obj(stripWrapper(content, "dictionary"));
        Map<String, String> columns = new LinkedHashMap<>();
        JsonNode columnsNode = root.node("columns");
        if (columnsNode != null) {
            columnsNode.fields().forEachRemaining(e -> columns.put(e.getKey(), e.getValue().asText()));
        }
        return new Parsed<>(new Dictionary(columns, root.rest()), List.of());
    }

    // -------------------------------------------------------------- pieces

    private Column readColumn(JsonNode node, List<String> warnings) {
        Obj o = new Obj(asObject(node, "columns[]"));
        String name = o.requiredText("name");
        String type = o.text("type");
        String logicalTypeRaw = o.text("logicalType");
        // V-2: 不明な logicalType は other にフォールバックして警告
        if (logicalTypeRaw != null && !LogicalType.isKnown(logicalTypeRaw)) {
            warnings.add("unknown logicalType \"" + logicalTypeRaw + "\" on column \"" + name
                    + "\" (falling back to other)");
        }
        LogicalType logicalType = LogicalType.fromJson(logicalTypeRaw);
        boolean nullable = o.bool("nullable", true);
        String defaultValue = o.text("default");
        boolean autoIncrement = o.bool("autoIncrement", false);
        boolean generated = o.bool("generated", false);
        String comment = o.text("comment");
        return new Column(name, type == null ? "" : type, logicalType, nullable,
                defaultValue, autoIncrement, generated, comment, o.rest());
    }

    private TableMeta readMeta(JsonNode node, List<String> warnings) {
        if (node == null) return TableMeta.EMPTY;
        Obj o = new Obj(asObject(node, "meta"));

        String displayName = o.text("displayName");
        List<String> tags = o.textArray("tags");
        String notes = o.text("notes");

        Map<String, ColumnMeta> columns = new LinkedHashMap<>();
        JsonNode columnsNode = o.node("columns");
        if (columnsNode != null) {
            columnsNode.fields().forEachRemaining(e -> {
                Obj cm = new Obj(asObject(e.getValue(), "meta.columns." + e.getKey()));
                columns.put(e.getKey(), new ColumnMeta(cm.text("displayName"), cm.text("notes"), cm.rest()));
            });
        }

        List<LogicalUnique> logicalUniques = new ArrayList<>();
        for (JsonNode lu : o.array("logicalUniques")) {
            Obj x = new Obj(asObject(lu, "meta.logicalUniques[]"));
            logicalUniques.add(new LogicalUnique(x.requiredText("name"), x.textArray("columns"), x.text("notes")));
        }

        List<LogicalForeignKey> logicalForeignKeys = new ArrayList<>();
        for (JsonNode lfk : o.array("logicalForeignKeys")) {
            Obj x = new Obj(asObject(lfk, "meta.logicalForeignKeys[]"));
            logicalForeignKeys.add(new LogicalForeignKey(
                    x.requiredText("name"), x.textArray("columns"), readRef(x.node("ref")), x.text("notes")));
        }

        Map<String, RelationMeta> relations = new LinkedHashMap<>();
        JsonNode relationsNode = o.node("relations");
        if (relationsNode != null) {
            relationsNode.fields().forEachRemaining(e -> {
                Obj rm = new Obj(asObject(e.getValue(), "meta.relations." + e.getKey()));
                relations.put(e.getKey(),
                        new RelationMeta(rm.text("parent"), rm.text("child"), rm.text("notes"), rm.rest()));
            });
        }

        return new TableMeta(displayName, tags, notes, columns, logicalUniques, logicalForeignKeys,
                relations, o.rest());
    }

    private Ref readRef(JsonNode node) {
        Obj o = new Obj(asObject(node, "ref"));
        return new Ref(o.requiredText("table"), o.textArray("columns"));
    }

    private Point readPoint(JsonNode node, String where) {
        if (node == null || !node.isArray() || node.size() != 2) {
            throw new DataFileException("expected [x, y] at " + where);
        }
        return new Point(node.get(0).asInt(), node.get(1).asInt());
    }

    // ------------------------------------------------------------- wrapper

    /** ラッパを剥がし、中身のオブジェクトリテラルを返す（§3.2）。 */
    ObjectNode stripWrapper(String content, String expectedFn) {
        Matcher m = WRAPPER.matcher(content);
        if (!m.matches()) {
            throw new DataFileException("file is not a single ERD.<fn>({...}); call");
        }
        String fn = m.group(1);
        if (!fn.equals(expectedFn)) {
            throw new DataFileException("expected ERD." + expectedFn + "( but found ERD." + fn + "(");
        }
        JsonNode node;
        try {
            node = MAPPER.readTree(m.group(2));
        } catch (Exception e) {
            throw new DataFileException("failed to parse object literal: " + e.getMessage(), e);
        }
        if (node == null || !node.isObject()) {
            throw new DataFileException("wrapper body is not a single object literal");
        }
        return (ObjectNode) node;
    }

    private static ObjectNode asObject(JsonNode node, String where) {
        if (node == null || !node.isObject()) {
            throw new DataFileException("expected an object at " + where);
        }
        return (ObjectNode) node;
    }

    private static String textOrNull(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static Map<String, JsonNode> objectAsMap(JsonNode node) {
        Map<String, JsonNode> map = new LinkedHashMap<>();
        if (node != null && node.isObject()) {
            node.fields().forEachRemaining(e -> map.put(e.getKey(), e.getValue()));
        }
        return map;
    }

    /** 既知キーの消費を追跡し、残りを unknown として返す（V-4）。 */
    private static final class Obj {
        private final ObjectNode node;
        private final Set<String> consumed = new LinkedHashSet<>();

        Obj(ObjectNode node) {
            this.node = node;
        }

        JsonNode node(String key) {
            JsonNode n = node.get(key);
            if (n != null) consumed.add(key);
            return n == null || n.isNull() ? null : n;
        }

        String text(String key) {
            JsonNode n = node(key);
            return n == null ? null : n.asText();
        }

        String requiredText(String key) {
            String v = text(key);
            if (v == null || v.isEmpty()) {
                throw new DataFileException("required key missing: " + key);
            }
            return v;
        }

        boolean bool(String key, boolean def) {
            JsonNode n = node(key);
            return n == null ? def : n.asBoolean(def);
        }

        int integer(String key, int def) {
            JsonNode n = node(key);
            return n == null ? def : n.asInt(def);
        }

        Integer integerOrNull(String key) {
            JsonNode n = node(key);
            return n == null ? null : n.asInt();
        }

        List<String> textArray(String key) {
            JsonNode n = node(key);
            if (n == null) return List.of();
            List<String> out = new ArrayList<>();
            for (JsonNode el : n) {
                out.add(el.asText());
            }
            return out;
        }

        List<JsonNode> array(String key) {
            JsonNode n = node(key);
            if (n == null) return List.of();
            List<JsonNode> out = new ArrayList<>();
            n.forEach(out::add);
            return out;
        }

        /** 未消費のキーを元の順序で返す。 */
        Map<String, JsonNode> rest() {
            Map<String, JsonNode> restMap = new LinkedHashMap<>();
            node.fields().forEachRemaining(e -> {
                if (!consumed.contains(e.getKey())) {
                    restMap.put(e.getKey(), e.getValue());
                }
            });
            return restMap;
        }
    }
}
