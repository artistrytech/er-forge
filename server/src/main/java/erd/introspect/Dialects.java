package erd.introspect;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.model.TableSchema;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.TreeMap;

/**
 * 層2（{@link DialectEnhancer}）の発見・適用と、dialect の組み立て（§7.1 / §7.4）。
 *
 * <p><b>Enhancer の失敗は内省全体を失敗させない。</b> 層1（JDBC 標準）だけで最低限動作するのが
 * 2層構成の要点であり、DB固有の追加 SQL が権限やバージョンで通らないことは通常運転の範囲にある。
 * 失敗は警告として持ち帰り、dialect が空のまま先へ進む。
 *
 * <p>dialect は {@code data/schema/**.js} に書き出されるため、<b>出力は決定論的でなければならない</b>
 * （キー順が揺れると意味のない Git 差分が出る）。ここで組み立てるマップはすべてキー昇順に揃える。
 */
public final class Dialects {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /** dialect のキー順（テーブル単位。この順で出力される）。 */
    private static final List<String> KEY_ORDER = List.of("checks", "enums", "indexes");

    private Dialects() {}

    /**
     * ServiceLoader で Enhancer を発見し、この DB に対応するものをすべて適用する。
     *
     * @return dialect を書き足した RawSchema（対応する Enhancer が無ければ入力をそのまま返す）
     */
    public static RawSchema enhance(Connection conn, RawSchema schema) {
        RawSchema current = schema;
        List<String> warnings = new ArrayList<>(schema.warnings());
        DatabaseMetaData md;
        try {
            md = conn.getMetaData();
        } catch (SQLException e) {
            return schema;
        }
        for (DialectEnhancer enhancer : ServiceLoader.load(DialectEnhancer.class,
                Dialects.class.getClassLoader())) {
            try {
                if (!enhancer.supports(md)) continue;
                current = enhancer.enhance(conn, current);
            } catch (SQLException | RuntimeException e) {
                warnings.add(enhancer.getClass().getSimpleName()
                        + ": Could not read database-specific metadata (" + e.getMessage() + ")");
            }
        }
        if (warnings.size() == current.warnings().size()) return current;
        return new RawSchema(current.product(), current.version(), current.driver(),
                current.namespace(), current.tables(), warnings);
    }

    // ------------------------------------------------------------ dialect の組み立て

    /** 1テーブル分の dialect を決定論的に組み立てるビルダ。 */
    public static final class Builder {
        private final List<ObjectNode> checks = new ArrayList<>();
        private final Map<String, List<String>> enums = new TreeMap<>();
        private final List<ObjectNode> indexes = new ArrayList<>();
        private List<String> definition = List.of();

        /** CHECK 制約（JDBC 標準に API が存在しない。§7.4）。 */
        public void addCheck(String name, String expression) {
            ObjectNode n = NODES.objectNode();
            n.put("name", name);
            n.put("expression", expression);
            checks.add(n);
        }

        /** ENUM 値（PostgreSQL の enum 型 / MySQL の enum・set 列）。 */
        public void addEnum(String column, List<String> values) {
            enums.put(column, List.copyOf(values));
        }

        /** 部分インデックス・式インデックス（標準メタデータでは表現できない。§7.4）。 */
        public void addIndex(String name, String definition, String predicate) {
            ObjectNode n = NODES.objectNode();
            n.put("name", name);
            if (definition != null) n.put("definition", definition);
            if (predicate != null) n.put("predicate", predicate);
            indexes.add(n);
        }

        /**
         * ビュー等の定義 SQL（K-18）。<b>dialect には入れない。</b>
         * dialect は差分検出でマップ全体を1項目として比較するため、そこに入れると
         * 「定義が変わった」しか分からず、差分プレビューが実用にならない。
         *
         * <p>行に分けて保持する。改行を含む1本の文字列にすると、プリンタが {@code \n} を
         * エスケープして1行に畳み、「1つの変更 = 1行の差分」（INV-5）が壊れる。
         */
        public void setDefinition(String sql) {
            definition = splitLines(sql);
        }

        /**
         * 決定論的な行分割。行末の空白を落とし、末尾の空行を捨てる
         * （同じ定義から常に同じ配列が出ないと、意味のない Git 差分が出る）。
         */
        static List<String> splitLines(String sql) {
            if (sql == null) return List.of();
            List<String> lines = new ArrayList<>();
            for (String raw : sql.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1)) {
                lines.add(raw.stripTrailing());
            }
            while (!lines.isEmpty() && lines.get(lines.size() - 1).isEmpty()) {
                lines.remove(lines.size() - 1);
            }
            while (!lines.isEmpty() && lines.get(0).isEmpty()) {
                lines.remove(0);
            }
            return List.copyOf(lines);
        }

        List<String> definition() {
            return definition;
        }

        boolean isEmpty() {
            return checks.isEmpty() && enums.isEmpty() && indexes.isEmpty() && definition.isEmpty();
        }

        /** キー順・要素順を固定した dialect マップ。 */
        Map<String, JsonNode> build() {
            Map<String, JsonNode> out = new LinkedHashMap<>();
            for (String key : KEY_ORDER) {
                switch (key) {
                    case "checks" -> {
                        if (!checks.isEmpty()) out.put(key, sortedByName(checks));
                    }
                    case "enums" -> {
                        if (!enums.isEmpty()) {
                            ObjectNode obj = NODES.objectNode();
                            enums.forEach((col, values) -> {
                                ArrayNode arr = obj.putArray(col);
                                values.forEach(arr::add);
                            });
                            out.put(key, obj);
                        }
                    }
                    case "indexes" -> {
                        if (!indexes.isEmpty()) out.put(key, sortedByName(indexes));
                    }
                    default -> throw new IllegalStateException(key);
                }
            }
            return out;
        }

        private static ArrayNode sortedByName(List<ObjectNode> items) {
            ArrayNode arr = NODES.arrayNode();
            items.stream()
                    .sorted(java.util.Comparator.comparing(n -> n.path("name").asText("")))
                    .forEach(arr::add);
            return arr;
        }
    }

    /**
     * テーブル名 → Builder を RawSchema に反映する。
     * dialect が空のテーブルはキー自体を出力しない（省略可能なキーは省く。§5.11）。
     */
    public static RawSchema merge(RawSchema schema, Map<String, Builder> byTable) {
        List<TableSchema> tables = new ArrayList<>();
        for (TableSchema t : schema.tables()) {
            Builder b = byTable.get(t.name());
            if (b == null || b.isEmpty()) {
                tables.add(t);
                continue;
            }
            Map<String, JsonNode> dialect = new LinkedHashMap<>(t.dialect());
            dialect.putAll(b.build());
            // definition は dialect ではなく一級のフィールドへ入れる（K-18）
            List<String> definition = b.definition().isEmpty() ? t.definition() : b.definition();
            tables.add(new TableSchema(t.name(), t.schema(), t.kind(), t.comment(), t.columns(),
                    t.primaryKey(), t.uniques(), t.indexes(), t.foreignKeys(), definition, dialect));
        }
        return new RawSchema(schema.product(), schema.version(), schema.driver(),
                schema.namespace(), tables, schema.warnings());
    }
}
