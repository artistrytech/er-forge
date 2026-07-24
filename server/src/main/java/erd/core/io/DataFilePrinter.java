package erd.core.io;

import com.fasterxml.jackson.databind.JsonNode;
import erd.core.index.IndexModel;
import erd.core.model.Column;
import erd.core.model.DiagramPage;
import erd.core.model.Dictionary;
import erd.core.model.DriverConfig;
import erd.core.model.EdgeLayout;
import erd.core.model.ForeignKey;
import erd.core.model.IndexDef;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalUnique;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
import erd.core.model.ProjectConfig;
import erd.core.model.RelationMeta;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.UniqueConstraint;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 決定論的プリンタ（Phase0 詳細設計 §2）。
 *
 * <p>不変条件:
 * INV-1 往復同一（parse → print がバイト一致）/ INV-2 モデル同一 → 出力同一 /
 * INV-4 日本語をエスケープしない / INV-5 1つの変更 = 1行の差分。
 *
 * <p>出力は LF・UTF-8（BOM なし）・末尾改行1つ・インデント2スペース・
 * ブロック要素は末尾カンマ・ヘッダコメントなし。
 */
public final class DataFilePrinter {

    /** ソートは常に Unicode コードポイント順（ロケール依存ソートは INV-2 を破る）。 */
    public static final Comparator<String> CODEPOINT_ORDER = (a, b) -> {
        int i = 0, j = 0;
        while (i < a.length() && j < b.length()) {
            int ca = a.codePointAt(i);
            int cb = b.codePointAt(j);
            if (ca != cb) return Integer.compare(ca, cb);
            i += Character.charCount(ca);
            j += Character.charCount(cb);
        }
        return Integer.compare(a.length() - i, b.length() - j);
    };

    // ---------------------------------------------------------------- table

    public String printTable(Table t) {
        Out out = new Out();
        out.open("ERD.table({");
        out.line("id: " + JsText.quote(t.id()) + ",");
        out.line("name: " + JsText.quote(t.schema().name()) + ",");
        if (t.schema().schema() != null) {
            out.line("schema: " + JsText.quote(t.schema().schema()) + ",");
        }
        if (notEmpty(t.schema().comment())) {
            out.line("comment: " + JsText.quote(t.schema().comment()) + ",");
        }
        out.open("columns: [");
        for (Column c : t.schema().columns()) {
            out.line(columnInline(c) + ",");
        }
        out.close("],");
        if (!t.schema().primaryKey().isEmpty()) {
            out.line("primaryKey: " + strArray(t.schema().primaryKey()) + ",");
        }
        if (!t.schema().uniques().isEmpty()) {
            out.open("uniques: [");
            for (UniqueConstraint u : sortedByName(t.schema().uniques(), UniqueConstraint::name)) {
                out.line(uniqueInline(u) + ",");
            }
            out.close("],");
        }
        if (!t.schema().indexes().isEmpty()) {
            out.open("indexes: [");
            for (IndexDef ix : sortedByName(t.schema().indexes(), IndexDef::name)) {
                out.line(indexInline(ix) + ",");
            }
            out.close("],");
        }
        if (!t.schema().foreignKeys().isEmpty()) {
            out.open("foreignKeys: [");
            for (ForeignKey fk : sortedByName(t.schema().foreignKeys(), ForeignKey::name)) {
                out.line(fkInline(fk) + ",");
            }
            out.close("],");
        }
        if (!t.schema().dialect().isEmpty()) {
            out.open("dialect: {");
            emitUnknown(out, t.schema().dialect());
            out.close("},");
        }
        if (!t.meta().isEmpty()) {
            printMeta(out, t);
        }
        emitUnknown(out, t.unknown());
        out.close("});");
        return out.result();
    }

    private void printMeta(Out out, Table t) {
        TableMeta m = t.meta();
        out.open("meta: {");
        if (notEmpty(m.displayName())) {
            out.line("displayName: " + JsText.quote(m.displayName()) + ",");
        }
        if (!m.tags().isEmpty()) {
            out.line("tags: " + strArray(m.tags()) + ",");
        }
        if (notEmpty(m.notes())) {
            out.line("notes: " + JsText.quote(m.notes()) + ",");
        }
        if (!m.columns().isEmpty()) {
            // 並びはテーブルの columns の物理順（カラム表と揃う）。孤児はコードポイント順で後置
            List<String> order = new ArrayList<>();
            for (Column c : t.schema().columns()) {
                if (m.columns().containsKey(c.name())) order.add(c.name());
            }
            m.columns().keySet().stream()
                    .filter(k -> !order.contains(k))
                    .sorted(CODEPOINT_ORDER)
                    .forEach(order::add);
            Out.Block block = null;
            for (String name : order) {
                var cm = m.columns().get(name);
                if (cm.isEmpty()) continue;
                if (block == null) block = out.openBlock("columns: {");
                Pairs p = new Pairs();
                if (notEmpty(cm.displayName())) p.add("displayName", JsText.quote(cm.displayName()));
                if (notEmpty(cm.notes())) p.add("notes", JsText.quote(cm.notes()));
                addUnknownInline(p, cm.unknown());
                out.line(JsText.key(name) + ": " + p.inline() + ",");
            }
            if (block != null) out.close("},");
        }
        if (!m.logicalUniques().isEmpty()) {
            out.open("logicalUniques: [");
            for (LogicalUnique lu : sortedByName(m.logicalUniques(), LogicalUnique::name)) {
                Pairs p = new Pairs();
                p.add("name", JsText.quote(lu.name()));
                p.add("columns", strArray(lu.columns()));
                if (notEmpty(lu.notes())) p.add("notes", JsText.quote(lu.notes()));
                out.line(p.inline() + ",");
            }
            out.close("],");
        }
        if (!m.logicalForeignKeys().isEmpty()) {
            out.open("logicalForeignKeys: [");
            for (LogicalForeignKey lfk : sortedByName(m.logicalForeignKeys(), LogicalForeignKey::name)) {
                Pairs p = new Pairs();
                p.add("name", JsText.quote(lfk.name()));
                p.add("columns", strArray(lfk.columns()));
                p.add("ref", refInline(lfk.ref()));
                if (notEmpty(lfk.notes())) p.add("notes", JsText.quote(lfk.notes()));
                out.line(p.inline() + ",");
            }
            out.close("],");
        }
        if (!m.relations().isEmpty()) {
            out.open("relations: {");
            m.relations().keySet().stream().sorted(CODEPOINT_ORDER).forEach(key -> {
                RelationMeta rm = m.relations().get(key);
                Pairs p = new Pairs();
                if (rm.parent() != null) p.add("parent", JsText.quote(rm.parent()));
                if (rm.child() != null) p.add("child", JsText.quote(rm.child()));
                if (notEmpty(rm.notes())) p.add("notes", JsText.quote(rm.notes()));
                addUnknownInline(p, rm.unknown());
                out.line(JsText.key(key) + ": " + p.inline() + ",");
            });
            out.close("},");
        }
        emitUnknown(out, m.unknown());
        out.close("},");
    }

    private String columnInline(Column c) {
        Pairs p = new Pairs();
        p.add("name", JsText.quote(c.name()));
        p.add("type", JsText.quote(c.type()));
        p.add("logicalType", JsText.quote(c.logicalType().jsonName()));
        p.add("nullable", String.valueOf(c.nullable())); // 常に出力（可読性の例外）
        if (c.defaultValue() != null) p.add("default", JsText.quote(c.defaultValue()));
        if (c.autoIncrement()) p.add("autoIncrement", "true");
        if (c.generated()) p.add("generated", "true");
        if (notEmpty(c.comment())) p.add("comment", JsText.quote(c.comment()));
        addUnknownInline(p, c.unknown());
        return p.inline();
    }

    private String uniqueInline(UniqueConstraint u) {
        Pairs p = new Pairs();
        p.add("name", JsText.quote(u.name()));
        p.add("columns", strArray(u.columns()));
        return p.inline();
    }

    private String indexInline(IndexDef ix) {
        Pairs p = new Pairs();
        p.add("name", JsText.quote(ix.name()));
        p.add("columns", strArray(ix.columns()));
        if (ix.unique()) p.add("unique", "true");
        return p.inline();
    }

    private String fkInline(ForeignKey fk) {
        Pairs p = new Pairs();
        p.add("name", JsText.quote(fk.name()));
        p.add("columns", strArray(fk.columns()));
        p.add("ref", refInline(fk.ref()));
        if (!ForeignKey.DEFAULT_ACTION.equals(fk.onDelete())) p.add("onDelete", JsText.quote(fk.onDelete()));
        if (!ForeignKey.DEFAULT_ACTION.equals(fk.onUpdate())) p.add("onUpdate", JsText.quote(fk.onUpdate()));
        return p.inline();
    }

    private String refInline(erd.core.model.Ref ref) {
        Pairs p = new Pairs();
        p.add("table", JsText.quote(ref.table()));
        p.add("columns", strArray(ref.columns()));
        return p.inline();
    }

    // -------------------------------------------------------------- diagram

    public String printDiagram(DiagramPage d) {
        Out out = new Out();
        out.open("ERD.diagram({");
        out.line("id: " + JsText.quote(d.id()) + ",");
        out.line("title: " + JsText.quote(d.title()) + ",");
        out.line("order: " + d.order() + ",");
        if (!d.nodes().isEmpty()) {
            out.open("nodes: {");
            d.nodes().keySet().stream().sorted(CODEPOINT_ORDER).forEach(id -> {
                NodeLayout n = d.nodes().get(id);
                Pairs p = new Pairs();
                p.add("pos", pointInline(n.pos()));
                if (n.w() != null) p.add("w", n.w().toString());
                addUnknownInline(p, n.unknown());
                out.line(JsText.key(id) + ": " + p.inline() + ",");
            });
            out.close("},");
        }
        if (!d.edges().isEmpty()) {
            out.open("edges: {");
            d.edges().keySet().stream().sorted(CODEPOINT_ORDER).forEach(id -> {
                EdgeLayout e = d.edges().get(id);
                Pairs p = new Pairs();
                if (!e.waypoints().isEmpty()) {
                    List<String> pts = e.waypoints().stream().map(this::pointInline).toList();
                    p.add("waypoints", "[" + String.join(", ", pts) + "]");
                }
                addUnknownInline(p, e.unknown());
                out.line(JsText.key(id) + ": " + p.inline() + ",");
            });
            out.close("},");
        }
        emitUnknown(out, d.unknown());
        out.close("});");
        return out.result();
    }

    private String pointInline(Point p) {
        return "[" + p.x() + ", " + p.y() + "]";
    }

    // ------------------------------------------------------------- manifest

    public String printManifest(Manifest m) {
        Out out = new Out();
        out.open("ERD.manifest({");
        out.line("schemaVersion: " + m.schemaVersion() + ",");
        if (m.generatedAt() != null) {
            out.line("generatedAt: " + JsText.quote(m.generatedAt()) + ",");
        }
        if (m.source() != null) {
            Pairs p = new Pairs();
            p.add("product", JsText.quote(m.source().product()));
            p.add("version", JsText.quote(m.source().version()));
            out.line("source: " + p.inline() + ",");
        }
        if (m.config() != null) {
            out.line("config: " + JsText.quote(m.config()) + ",");
        }
        if (m.dictionary() != null) {
            out.line("dictionary: " + JsText.quote(m.dictionary()) + ",");
        }
        if (!m.tables().isEmpty()) {
            out.open("tables: {");
            m.tables().keySet().stream().sorted(CODEPOINT_ORDER).forEach(id ->
                    out.line(JsText.key(id) + ": " + JsText.quote(m.tables().get(id)) + ","));
            out.close("},");
        }
        if (!m.diagrams().isEmpty()) {
            out.open("diagrams: [");
            m.diagrams().stream()
                    .sorted(Comparator.comparingInt(Manifest.DiagramRef::order)
                            .thenComparing(Manifest.DiagramRef::id, CODEPOINT_ORDER))
                    .forEach(d -> {
                        Pairs p = new Pairs();
                        p.add("id", JsText.quote(d.id()));
                        p.add("file", JsText.quote(d.file()));
                        if (d.title() != null) p.add("title", JsText.quote(d.title()));
                        p.add("order", String.valueOf(d.order()));
                        out.line(p.inline() + ",");
                    });
            out.close("],");
        }
        emitUnknown(out, m.unknown());
        out.close("});");
        return out.result();
    }

    // --------------------------------------------------------------- config

    public String printConfig(ProjectConfig c) {
        Out out = new Out();
        out.open("ERD.config({");
        if (!c.ignoreTables().isEmpty()) {
            out.open("ignoreTables: [");
            // 人が書いた順を維持する（意味のある並びかもしれないため、ソートしない）
            for (String pattern : c.ignoreTables()) {
                out.line(JsText.quote(pattern) + ",");
            }
            out.close("],");
        }
        DriverConfig d = c.drivers();
        if (d != null && !d.isEmpty()) {
            out.open("drivers: {");
            if (d.mavenRepository() != null && !d.mavenRepository().isBlank()) {
                out.line("mavenRepository: " + JsText.quote(d.mavenRepository()) + ",");
            }
            if (!d.artifacts().isEmpty()) {
                out.open("artifacts: [");
                // 人が書いた順を維持する（ソートしない）
                for (String a : d.artifacts()) {
                    out.line(JsText.quote(a) + ",");
                }
                out.close("],");
            }
            out.close("},");
        }
        emitUnknown(out, c.unknown());
        out.close("});");
        return out.result();
    }

    // ----------------------------------------------------------- dictionary

    public String printDictionary(Dictionary d) {
        Out out = new Out();
        out.open("ERD.dictionary({");
        if (!d.columns().isEmpty()) {
            out.open("columns: {");
            d.columns().keySet().stream().sorted(CODEPOINT_ORDER).forEach(name ->
                    out.line(JsText.key(name) + ": " + JsText.quote(d.columns().get(name)) + ","));
            out.close("},");
        }
        emitUnknown(out, d.unknown());
        out.close("});");
        return out.result();
    }

    // ---------------------------------------------------------------- index

    public String printIndex(IndexModel ix) {
        Out out = new Out();
        out.open("ERD.index({");
        if (!ix.tables().isEmpty()) {
            out.open("tables: [");
            ix.tables().stream()
                    .sorted(Comparator.comparing(IndexModel.TableEntry::id, CODEPOINT_ORDER))
                    .forEach(t -> {
                        Pairs p = new Pairs();
                        p.add("id", JsText.quote(t.id()));
                        p.add("name", JsText.quote(t.name()));
                        if (t.schema() != null) p.add("schema", JsText.quote(t.schema()));
                        if (notEmpty(t.displayName())) p.add("displayName", JsText.quote(t.displayName()));
                        p.add("columns", String.valueOf(t.columns()));
                        p.add("pk", String.valueOf(t.pk()));
                        if (!t.tags().isEmpty()) p.add("tags", strArray(t.tags()));
                        if (!t.diagrams().isEmpty()) p.add("diagrams", strArray(t.diagrams()));
                        out.line(p.inline() + ",");
                    });
            out.close("],");
        }
        if (!ix.relations().isEmpty()) {
            out.open("relations: [");
            ix.relations().stream()
                    .sorted(Comparator.comparing(IndexModel.RelationEntry::id, CODEPOINT_ORDER))
                    .forEach(r -> {
                        Pairs p = new Pairs();
                        p.add("id", JsText.quote(r.id()));
                        p.add("kind", JsText.quote(r.kind()));
                        p.add("from", JsText.quote(r.from()));
                        p.add("to", JsText.quote(r.to()));
                        List<String> pairs = r.columns().stream().map(this::strArray).toList();
                        p.add("columns", "[" + String.join(", ", pairs) + "]");
                        Pairs card = new Pairs();
                        card.add("parent", JsText.quote(r.cardinality().parent()));
                        card.add("child", JsText.quote(r.cardinality().child()));
                        p.add("cardinality", card.inline());
                        if (!r.explicit().isEmpty()) p.add("explicit", strArray(r.explicit()));
                        if (r.dangling()) p.add("dangling", "true");
                        out.line(p.inline() + ",");
                    });
            out.close("],");
        }
        out.close("});");
        return out.result();
    }

    // -------------------------------------------------------------- helpers

    private static boolean notEmpty(String s) {
        return s != null && !s.isEmpty();
    }

    private String strArray(List<String> values) {
        return "[" + String.join(", ", values.stream().map(JsText::quote).toList()) + "]";
    }

    /** 制約は制約名の昇順（DB が返す順は不定のため、決定論的にソートする）。 */
    private static <T> List<T> sortedByName(List<T> items, java.util.function.Function<T, String> name) {
        return items.stream().sorted(Comparator.comparing(name, CODEPOINT_ORDER)).toList();
    }

    private void addUnknownInline(Pairs p, Map<String, JsonNode> unknown) {
        unknown.forEach((k, v) -> p.add(k, JsValues.inline(v)));
    }

    /** ブロック文脈での未知キー・dialect の出力（元のキー順を維持する）。 */
    private void emitUnknown(Out out, Map<String, JsonNode> unknown) {
        unknown.forEach((k, v) -> emitGeneric(out, JsText.key(k) + ": ", v));
    }

    private void emitGeneric(Out out, String prefix, JsonNode v) {
        if (!JsValues.isBlock(v)) {
            out.line(prefix + JsValues.inline(v) + ",");
            return;
        }
        if (v.isObject()) {
            out.open(prefix + "{");
            Map<String, JsonNode> fields = new LinkedHashMap<>();
            v.fields().forEachRemaining(e -> fields.put(e.getKey(), e.getValue()));
            fields.forEach((k, val) -> emitGeneric(out, JsText.key(k) + ": ", val));
            out.close("},");
        } else {
            out.open(prefix + "[");
            for (JsonNode el : v) {
                emitGeneric(out, "", el);
            }
            out.close("],");
        }
    }

    /** インデント付きの行バッファ。改行は LF、末尾に改行1つ。 */
    private static final class Out {
        private final StringBuilder sb = new StringBuilder();
        private int depth;

        void line(String s) {
            sb.append("  ".repeat(depth)).append(s).append('\n');
        }

        void open(String s) {
            line(s);
            depth++;
        }

        Block openBlock(String s) {
            open(s);
            return new Block();
        }

        void close(String s) {
            depth--;
            line(s);
        }

        String result() {
            return sb.toString();
        }

        /** openBlock の目印（遅延 open 用）。 */
        static final class Block {}
    }

    /** 1行オブジェクト（compact object）のペア列。 */
    private static final class Pairs {
        private final List<String> parts = new ArrayList<>();

        void add(String key, String value) {
            parts.add(JsText.key(key) + ": " + value);
        }

        String inline() {
            if (parts.isEmpty()) return "{}";
            return "{ " + String.join(", ", parts) + " }";
        }
    }
}
