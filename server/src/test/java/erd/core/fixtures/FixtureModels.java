package erd.core.fixtures;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.index.IndexGenerator;
import erd.core.index.IndexModel;
import erd.core.model.Column;
import erd.core.model.ColumnMeta;
import erd.core.model.DiagramPage;
import erd.core.model.Dictionary;
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

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * golden fixture の単一のソース（Phase0 詳細設計 §1.3）。
 * Java / TS 双方のテストがここから生成されたファイルを読む。
 * フィールドを追加するときは、必ずここに fixture を追加する。
 */
public final class FixtureModels {
    private FixtureModels() {}

    private static final JsonNodeFactory F = JsonNodeFactory.instance;

    public static Table usersTable() {
        TableSchema schema = new TableSchema(
                "users", "public", "ユーザーマスタ",
                List.of(
                        new Column("id", "bigserial", LogicalType.INT, false, null, true, false, null, Map.of()),
                        new Column("email", "varchar(255)", LogicalType.STRING, false),
                        new Column("org_id", "int8", LogicalType.INT, true),
                        new Column("last_order_id", "int8", LogicalType.INT, true),
                        new Column("created_at", "timestamptz", LogicalType.DATETIME, false,
                                "now()", false, false, "作成日時", Map.of())),
                List.of("id"),
                List.of(new UniqueConstraint("users_email_key", List.of("email"))),
                List.of(new IndexDef("idx_users_created_at", List.of("created_at"), false)),
                List.of(new ForeignKey("users_org_id_fkey", List.of("org_id"),
                        new Ref("public.organizations", List.of("id")), "set null", null)),
                Map.of());
        // カラムのタグ・色（P-12 / P-13）を含める。タグと色は独立に付けられる
        Map<String, ColumnMeta> userColumnMeta = new LinkedHashMap<>();
        userColumnMeta.put("org_id",
                new ColumnMeta("所属組織ID", List.of("pii"), null, "NULL は個人アカウント", Map.of()));
        userColumnMeta.put("last_order_id",
                new ColumnMeta(null, List.of("廃止"), "muted", null, Map.of()));
        TableMeta meta = new TableMeta(
                "ユーザー",
                List.of("core", "auth"),
                "blue",
                "論理削除は deleted_at 運用",
                userColumnMeta,
                List.of(new LogicalUnique("luk_users_org_email", List.of("org_id", "email"),
                        "組織内でメールは重複しない（アプリ側で担保）")),
                List.of(new LogicalForeignKey("lfk_users_last_order", List.of("last_order_id"),
                        new Ref("public.orders", List.of("id")), "性能上 FK を張っていない")),
                Map.of("fk:users_org_id_fkey",
                        new RelationMeta(null, "1..N", "組織には必ず1人以上の利用者がいる")),
                Map.of());
        return new Table("public.users", schema, meta);
    }

    public static Table ordersTable() {
        TableSchema schema = new TableSchema(
                "orders", "public", "注文",
                List.of(
                        new Column("id", "bigserial", LogicalType.INT, false, null, true, false, null, Map.of()),
                        new Column("user_id", "int8", LogicalType.INT, false),
                        new Column("code", "varchar(32)", LogicalType.STRING, false),
                        new Column("total", "numeric(12,2)", LogicalType.DECIMAL, false, "0", false, false, null, Map.of()),
                        new Column("created_at", "timestamptz", LogicalType.DATETIME, false,
                                "now()", false, false, null, Map.of())),
                List.of("id"),
                List.of(new UniqueConstraint("orders_code_key", List.of("code"))),
                List.of(),
                List.of(new ForeignKey("orders_user_id_fkey", List.of("user_id"),
                        new Ref("public.users", List.of("id")), null, null)),
                Map.of());
        TableMeta meta = new TableMeta(
                "注文", List.of("core"), null, null, Map.of(), List.of(),
                List.of(new LogicalForeignKey("lfk_orders_legacy", List.of("code"),
                        new Ref("public.legacy_orders", List.of("code")), "旧システムの注文（アーカイブ済み）")),
                Map.of(), Map.of());
        return new Table("public.orders", schema, meta);
    }

    public static Table organizationsTable() {
        TableSchema schema = new TableSchema(
                "organizations", "public", "組織",
                List.of(
                        new Column("id", "bigserial", LogicalType.INT, false, null, true, false, null, Map.of()),
                        new Column("name", "varchar(120)", LogicalType.STRING, false)),
                List.of("id"),
                List.of(), List.of(), List.of(), Map.of());
        return new Table("public.organizations", schema,
                new TableMeta("組織", List.of(), null, null, Map.of(), List.of(), List.of(),
                        Map.of(), Map.of()));
    }

    /** エスケープと予約語キーの網羅（T-5 / T-6）。notes に U+2028 / U+2029 / 改行 / タブ / 引用符を含む。 */
    public static Table escapeTable() {
        String notes = "1行目\n2行目\tタブ \"引用\" \\バックスラッシュ"
                + (char) 0x2028 + "LINE SEPARATOR " + (char) 0x2029 + "PARAGRAPH SEPARATOR ";
        TableSchema schema = new TableSchema(
                "escape_test", "public", null,
                List.of(
                        new Column("id", "int4", LogicalType.INT, false),
                        // 予約語のカラム名。meta.columns のキーとして出力されるとクォートが必要になる
                        new Column("default", "varchar(10)", LogicalType.STRING, true),
                        new Column("class", "varchar(10)", LogicalType.STRING, true)),
                List.of("id"),
                List.of(), List.of(), List.of(), Map.of());
        Map<String, ColumnMeta> columnMeta = new LinkedHashMap<>();
        columnMeta.put("default", new ColumnMeta("既定値", notes));
        columnMeta.put("class", new ColumnMeta("区分", null));
        TableMeta meta = new TableMeta(null, List.of(), null, notes, columnMeta,
                List.of(), List.of(), Map.of(), Map.of());
        return new Table("public.escape_test", schema, meta);
    }

    /** 未知キーの保持（T-10 / V-4）。新しいツールが書いたフィールドを消さない。 */
    public static Table unknownKeysTable() {
        ObjectNode nested = F.objectNode();
        nested.put("enabled", true);
        nested.set("thresholds", F.arrayNode().add(1).add(2).add(3));
        Map<String, JsonNode> tableUnknown = new LinkedHashMap<>();
        tableUnknown.put("futureFeature", nested);
        tableUnknown.put("futureFlag", F.booleanNode(true));

        Map<String, JsonNode> columnUnknown = new LinkedHashMap<>();
        columnUnknown.put("sensitivity", F.textNode("high"));

        Map<String, JsonNode> metaUnknown = new LinkedHashMap<>();
        metaUnknown.put("reviewedBy", F.textNode("本田"));

        TableSchema schema = new TableSchema(
                "future", "public", null,
                List.of(new Column("id", "int4", LogicalType.INT, false, null, false, false, null, columnUnknown)),
                List.of("id"),
                List.of(), List.of(), List.of(), Map.of());
        TableMeta meta = new TableMeta("未来", List.of(), null, null, Map.of(), List.of(), List.of(),
                Map.of(), metaUnknown);
        return new Table("public.future", schema, meta, tableUnknown);
    }

    public static DiagramPage coreDiagram() {
        Map<String, NodeLayout> nodes = new LinkedHashMap<>();
        nodes.put("public.users", new NodeLayout(new Point(120, 80), 260));
        nodes.put("public.orders", new NodeLayout(new Point(520, 80)));
        nodes.put("public.organizations", new NodeLayout(new Point(120, 400)));
        Map<String, EdgeLayout> edges = new LinkedHashMap<>();
        edges.put("public.users#fk:users_org_id_fkey",
                new EdgeLayout(List.of(new Point(380, 200), new Point(300, 320))));
        edges.put("public.orders#fk:orders_user_id_fkey", new EdgeLayout(List.of()));
        return new DiagramPage("core", "コアドメイン", 1, nodes, edges);
    }

    public static Manifest manifest() {
        Map<String, String> tables = new LinkedHashMap<>();
        tables.put("public.users", "schema/public/users.js");
        tables.put("public.orders", "schema/public/orders.js");
        tables.put("public.organizations", "schema/public/organizations.js");
        return new Manifest(1, "2026-07-12T00:00:00Z",
                new Manifest.Source("PostgreSQL", "16.2"),
                "config.js", "dictionary.js", tables,
                List.of(new Manifest.DiagramRef("core", "diagrams/core.js", "コアドメイン", 1)),
                Map.of());
    }

    public static ProjectConfig config() {
        return new ProjectConfig(List.of(
                "public.flyway_schema_history",
                "public.tmp_*",
                "/^staging\\..*_bak$/"), erd.core.model.DriverConfig.EMPTY, Map.of());
    }

    public static Dictionary dictionary() {
        Map<String, String> columns = new LinkedHashMap<>();
        columns.put("id", "ID");
        columns.put("created_at", "作成日時");
        columns.put("updated_at", "更新日時");
        columns.put("org_id", "組織ID");
        columns.put("email", "メールアドレス");
        columns.put("default", "既定値");
        return new Dictionary(columns, Map.of());
    }

    /** index.js は派生ファイル。fixture もモデルからの生成で固定する。 */
    public static IndexModel indexModel() {
        return new IndexGenerator().generate(
                List.of(usersTable(), ordersTable(), organizationsTable()),
                List.of(coreDiagram()));
    }
}
