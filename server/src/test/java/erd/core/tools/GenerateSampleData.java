package erd.core.tools;

import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import erd.core.model.Column;
import erd.core.model.ColumnMeta;
import erd.core.model.DiagramPage;
import erd.core.model.Dictionary;
import erd.core.model.DictionaryColumn;
import erd.core.model.EdgeLayout;
import erd.core.model.ForeignKey;
import erd.core.model.LogicalForeignKey;
import erd.core.model.LogicalType;
import erd.core.model.LogicalUnique;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
import erd.core.model.ProjectConfig;
import erd.core.model.ProjectModel;
import erd.core.model.Ref;
import erd.core.model.RelationMeta;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import erd.core.model.UniqueConstraint;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 同梱サンプルデータの生成（設計書 §3.6）。
 *
 * <p>dev-db/postgresql/migrations/000_init.sql（PostgreSQL DDL。dev-db の初期スキーマと
 * 共用する）をパースし、論理名・論理制約・
 * ER図ページの配置例を加えた「完成状態」の data/** を生成する。出力は
 * server/src/main/resources/erd-sample/ にコミットし、fat JAR に同梱する。
 * ブートストラップ（POST /__erd/bootstrap）がこれをプロジェクトへ書き出す。
 *
 * <p>使い方: gradle generateSampleData（出力を目視確認してコミットする）
 */
public final class GenerateSampleData {

    public static void main(String[] args) throws Exception {
        Path sqlFile = Path.of(args[0]);
        Path outDir = Path.of(args[1]);          // .../resources/erd-sample
        Path dataDir = outDir.resolve("data");

        String sql = Files.readString(sqlFile, StandardCharsets.UTF_8);
        List<Table> tables = parse(sql);
        enrich(tables);

        Manifest manifest = new Manifest(SchemaVersions.CURRENT,
                "config.js", "dictionary.js",
                Map.of(), List.of(), Map.of());
        ProjectModel model = new ProjectModel(manifest, ProjectConfig.EMPTY,
                dictionary(), tables, diagrams());

        new ProjectStore().writeAll(dataDir, model);

        // ブートストラップがリソースを列挙するためのファイル一覧
        List<String> files;
        try (Stream<Path> walk = Files.walk(dataDir)) {
            files = walk.filter(Files::isRegularFile)
                    .map(p -> dataDir.relativize(p).toString().replace('\\', '/'))
                    .sorted()
                    .toList();
        }
        Files.write(outDir.resolve("files.txt"),
                (String.join("\n", files) + "\n").getBytes(StandardCharsets.UTF_8));

        System.out.println("sample data written to " + dataDir.toAbsolutePath()
                + " (" + tables.size() + " tables, " + files.size() + " files)");
    }

    // ------------------------------------------------------------- DDL parse

    private static final Pattern CREATE =
            Pattern.compile("CREATE TABLE public\\.(\\w+) \\((.*?)\\);", Pattern.DOTALL);
    private static final Pattern COMMENT =
            Pattern.compile("COMMENT ON TABLE public\\.(\\w+) IS '(.*?)';");
    private static final Pattern REFERENCES =
            Pattern.compile("REFERENCES public\\.(\\w+)\\((\\w+)\\)");
    private static final Pattern DEFAULT =
            Pattern.compile("DEFAULT (CURRENT_TIMESTAMP|[\\w.']+)");

    private static List<Table> parse(String sql) {
        Map<String, String> comments = new LinkedHashMap<>();
        Matcher cm = COMMENT.matcher(sql);
        while (cm.find()) {
            comments.put(cm.group(1), cm.group(2));
        }

        List<Table> tables = new ArrayList<>();
        Matcher m = CREATE.matcher(sql);
        while (m.find()) {
            String name = m.group(1);
            List<Column> columns = new ArrayList<>();
            List<String> pk = new ArrayList<>();
            List<UniqueConstraint> uniques = new ArrayList<>();
            List<ForeignKey> fks = new ArrayList<>();

            for (String rawLine : splitTopLevel(m.group(2))) {
                String line = rawLine.replaceAll("--.*$", "").trim();
                if (line.isEmpty()) continue;
                if (line.startsWith("PRIMARY KEY")) {
                    for (String c : line.replaceAll("[^(]*\\(|\\)", "").split(",")) {
                        pk.add(c.trim());
                    }
                    continue;
                }
                int sp = line.indexOf(' ');
                String colName = line.substring(0, sp);
                String rest = line.substring(sp + 1).trim();
                String sqlType = rest.split(" ")[0];

                boolean isPk = rest.contains("PRIMARY KEY");
                if (isPk) pk.add(colName);
                boolean serial = sqlType.equals("SERIAL");
                boolean nullable = !isPk && !serial && !rest.contains("NOT NULL");
                String def = null;
                Matcher dm = DEFAULT.matcher(rest);
                if (dm.find()) {
                    def = dm.group(1).equals("CURRENT_TIMESTAMP") ? "now()" : dm.group(1);
                }
                columns.add(new Column(colName, pgType(sqlType), logicalType(sqlType),
                        nullable, def, serial, false, null, Map.of()));

                if (rest.contains("UNIQUE")) {
                    uniques.add(new UniqueConstraint(name + "_" + colName + "_key", List.of(colName)));
                }
                Matcher rm = REFERENCES.matcher(rest);
                if (rm.find()) {
                    fks.add(new ForeignKey(name + "_" + colName + "_fkey", List.of(colName),
                            new Ref("public." + rm.group(1), List.of(rm.group(2))),
                            ForeignKey.DEFAULT_ACTION, ForeignKey.DEFAULT_ACTION));
                }
            }
            TableSchema schema = new TableSchema(name, "public", comments.get(name),
                    columns, pk, uniques, List.of(), fks, Map.of());
            tables.add(new Table("public." + name, schema, TableMeta.EMPTY, Map.of()));
        }
        return tables;
    }

    /** カラム定義を括弧の外側のカンマでだけ分割する（NUMERIC(10,2) や複合PKのため）。 */
    private static List<String> splitTopLevel(String body) {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        StringBuilder cur = new StringBuilder();
        for (char c : body.toCharArray()) {
            if (c == '(') depth++;
            if (c == ')') depth--;
            if (c == ',' && depth == 0) {
                parts.add(cur.toString());
                cur.setLength(0);
            } else {
                cur.append(c);
            }
        }
        parts.add(cur.toString());
        return parts;
    }

    /** JDBC の TYPE_NAME 相当（PostgreSQL が内省で返す表記）へ正規化する。 */
    private static String pgType(String sqlType) {
        String t = sqlType.toLowerCase();
        if (t.equals("serial")) return "serial";
        if (t.equals("int")) return "int4";
        if (t.equals("timestamptz")) return "timestamptz";
        return t; // varchar(n) / numeric(p,s) / text / date はそのまま
    }

    private static LogicalType logicalType(String sqlType) {
        String t = sqlType.toLowerCase();
        if (t.equals("serial") || t.equals("int")) return LogicalType.INT;
        if (t.startsWith("numeric")) return LogicalType.DECIMAL;
        if (t.equals("timestamptz")) return LogicalType.DATETIME;
        if (t.equals("date")) return LogicalType.DATE;
        return LogicalType.STRING; // varchar / text
    }

    // ------------------------------------------------------------ enrichment

    /** タグ・論理名・論理制約・カーディナリティなど、人が整備した状態を再現する。 */
    private static void enrich(List<Table> tables) {
        Map<String, String> domainTag = new LinkedHashMap<>();
        for (String t : List.of("users", "user_profiles", "user_addresses", "user_sessions",
                "roles", "user_roles")) domainTag.put(t, "auth");
        for (String t : List.of("product_categories", "products", "product_images", "inventories",
                "product_reviews", "product_tags", "product_tag_mappings")) domainTag.put(t, "catalog");
        for (String t : List.of("orders", "order_items", "shipments", "order_status_logs",
                "order_cancellations")) domainTag.put(t, "order");
        for (String t : List.of("payment_methods", "payments", "payment_histories", "refunds"))
            domainTag.put(t, "billing");
        for (String t : List.of("points", "point_transactions", "point_campaigns",
                "point_bonus_rules")) domainTag.put(t, "point");
        List<String> masters = List.of("roles", "product_categories", "product_tags",
                "payment_methods", "point_campaigns");

        // 色はタグとは独立に人が選ぶもの（P-13）。ここでは業務ドメインごとに塗り分けた状態を再現する
        Map<String, String> domainColor = Map.of("auth", "blue", "catalog", "green",
                "order", "amber", "billing", "purple", "point", "red");

        for (int i = 0; i < tables.size(); i++) {
            Table t = tables.get(i);
            String name = t.schema().name();

            List<String> tags = new ArrayList<>();
            if (domainTag.containsKey(name)) tags.add(domainTag.get(name));
            if (masters.contains(name)) tags.add("master");
            String color = domainColor.get(domainTag.get(name));

            // 論理名の初期値は DB コメントの1行目（§5.8.2 の補完後の状態）
            String displayName = t.schema().comment();
            String notes = null;
            Map<String, ColumnMeta> columnMeta = new LinkedHashMap<>();
            List<LogicalUnique> logicalUniques = new ArrayList<>();
            List<LogicalForeignKey> logicalFks = new ArrayList<>();
            Map<String, RelationMeta> relations = new LinkedHashMap<>();

            switch (name) {
                case "user_profiles" -> logicalUniques.add(new LogicalUnique(
                        "luk_user_profiles_user", List.of("user_id"),
                        "1ユーザーにつきプロファイルは1件（アプリ側で担保）"));
                case "inventories" -> logicalUniques.add(new LogicalUnique(
                        "luk_inventories_product", List.of("product_id"),
                        "商品ごとに在庫レコードは1件"));
                case "points" -> logicalUniques.add(new LogicalUnique(
                        "luk_points_user", List.of("user_id"),
                        "ユーザーごとに残高レコードは1件"));
                case "point_transactions" -> {
                    logicalFks.add(new LogicalForeignKey("lfk_point_transactions_points",
                            List.of("user_id"), new Ref("public.points", List.of("user_id")),
                            "残高テーブルへの論理参照（履歴書き込みの性能上 FK は張っていない）"));
                    notes = "残高（points.balance）はこの履歴の集計と一致する運用";
                }
                case "order_items" -> {
                    logicalFks.add(new LogicalForeignKey("lfk_order_items_inventories",
                            List.of("product_id"), new Ref("public.inventories", List.of("product_id")),
                            "在庫への論理参照（FK なし。在庫行が後から作られることがある）"));
                    relations.put("fk:order_items_order_id_fkey", new RelationMeta(null, "1..N",
                            "注文には必ず1明細以上が存在する", Map.of()));
                }
                case "shipments" -> relations.put("fk:shipments_order_id_fkey",
                        new RelationMeta(null, "0..1", "注文につき出荷は最大1回（分割出荷はしない）", Map.of()));
                case "orders" -> columnMeta.put("status", new ColumnMeta("注文ステータス",
                        List.of("enum"), null, "PENDING / PAID / SHIPPED / CANCELLED", Map.of()));
                // 廃止したテーブル / カラムをグレーアウトした状態（タグで意味を、色で見た目を表す）
                case "point_bonus_rules" -> {
                    tags.add("廃止");
                    color = "muted";
                    notes = "新規のポイント付与では使わない（point_campaigns へ移行済み）";
                    columnMeta.put("bonus_rate", new ColumnMeta(null, List.of("廃止"), "muted",
                            "% 表記（例: 10.00）", Map.of()));
                }
                default -> { }
            }

            tables.set(i, new Table(t.id(), t.schema(),
                    new TableMeta(displayName, tags, color, notes, columnMeta,
                            logicalUniques, logicalFks, relations, Map.of()),
                    Map.of()));
        }
    }

    /** カラムの共通設定（横断辞書。§5.6）。同名カラムはプロジェクト全体で同じ意味を持つ。 */
    private static Dictionary dictionary() {
        Map<String, DictionaryColumn> c = new LinkedHashMap<>();
        put(c, "id", "ID");
        // 共通タグ・共通色（個別設定では取り消せないタグ / 個別設定で上書きできる色）
        c.put("created_at", new DictionaryColumn("作成日時", List.of("監査"), "muted", Map.of()));
        c.put("updated_at", new DictionaryColumn("更新日時", List.of("監査"), "muted", Map.of()));
        c.put("email", new DictionaryColumn("メールアドレス", List.of("pii"), "amber", Map.of()));
        c.put("password", new DictionaryColumn("パスワード", List.of("pii"), "red", Map.of()));
        c.put("phone_number", new DictionaryColumn("電話番号", List.of("pii"), "amber", Map.of()));
        c.put("birth_date", new DictionaryColumn("生年月日", List.of("pii"), "amber", Map.of()));
        put(c, "user_id", "ユーザーID");
        put(c, "product_id", "商品ID");
        put(c, "order_id", "注文ID");
        put(c, "payment_id", "支払ID");
        put(c, "campaign_id", "キャンペーンID");
        put(c, "category_id", "カテゴリID");
        put(c, "role_id", "ロールID");
        put(c, "tag_id", "タグID");
        put(c, "payment_method_id", "支払方法ID");
        put(c, "full_name", "氏名");
        put(c, "address_line1", "住所1");
        put(c, "address_line2", "住所2");
        put(c, "city", "市区町村");
        put(c, "postal_code", "郵便番号");
        put(c, "country", "国");
        put(c, "session_token", "セッショントークン");
        put(c, "expires_at", "有効期限");
        put(c, "role_name", "ロール名");
        put(c, "category_name", "カテゴリ名");
        put(c, "product_name", "商品名");
        put(c, "description", "説明");
        put(c, "price", "価格");
        put(c, "image_url", "画像URL");
        put(c, "quantity", "数量");
        put(c, "rating", "評価");
        put(c, "comment", "コメント");
        put(c, "tag_name", "タグ名");
        put(c, "order_date", "注文日時");
        put(c, "status", "ステータス");
        put(c, "shipment_date", "出荷日時");
        put(c, "carrier", "配送業者");
        put(c, "reason", "理由");
        put(c, "cancelled_at", "キャンセル日時");
        put(c, "method_name", "支払方法名");
        put(c, "payment_date", "支払日時");
        put(c, "amount", "金額");
        put(c, "processed_at", "処理日時");
        put(c, "refund_date", "返金日時");
        put(c, "balance", "残高");
        put(c, "points", "ポイント数");
        put(c, "transaction_date", "取引日時");
        put(c, "campaign_name", "キャンペーン名");
        put(c, "start_date", "開始日");
        put(c, "end_date", "終了日");
        put(c, "bonus_rate", "ボーナス率");
        return new Dictionary(c, Map.of());
    }

    /** 論理名だけの辞書エントリ。 */
    private static void put(Map<String, DictionaryColumn> c, String name, String displayName) {
        c.put(name, new DictionaryColumn(displayName));
    }

    // -------------------------------------------------------------- diagrams

    /** ER図ページの配置例。座標は 8px グリッド上の整数（§5.11）。 */
    private static List<DiagramPage> diagrams() {
        List<DiagramPage> pages = new ArrayList<>();
        pages.add(page("users", "ユーザー管理", 1, Map.of(
                "public.users", at(360, 56),
                "public.user_roles", at(640, 56),
                "public.roles", at(920, 56),
                "public.user_profiles", at(80, 256),
                "public.user_addresses", at(360, 256),
                "public.user_sessions", at(640, 256))));
        pages.add(page("products", "商品管理", 2, Map.of(
                "public.product_categories", at(80, 200),
                "public.products", at(392, 200),
                "public.product_images", at(760, 56),
                "public.inventories", at(760, 200),
                "public.product_reviews", at(760, 344),
                "public.product_tags", at(80, 488),
                "public.product_tag_mappings", at(392, 488),
                "public.users", at(1080, 488))));
        pages.add(page("orders", "注文管理", 3, Map.of(
                "public.users", at(80, 200),
                "public.orders", at(392, 200),
                "public.order_items", at(760, 56),
                "public.products", at(1080, 56),
                "public.inventories", at(1080, 200),
                "public.shipments", at(760, 200),
                "public.order_status_logs", at(760, 344),
                "public.order_cancellations", at(760, 488))));
        pages.add(page("payments", "決済", 4, Map.of(
                "public.orders", at(80, 200),
                "public.payments", at(392, 200),
                "public.payment_methods", at(80, 392),
                "public.payment_histories", at(760, 104),
                "public.refunds", at(760, 296))));
        pages.add(page("points", "ポイント", 5, Map.of(
                "public.users", at(80, 200),
                "public.points", at(392, 56),
                "public.point_transactions", at(392, 256),
                "public.point_campaigns", at(80, 448),
                "public.point_bonus_rules", at(392, 448))));
        return pages;
    }

    private static DiagramPage page(String id, String title, int order, Map<String, NodeLayout> nodes) {
        return new DiagramPage(id, title, order, nodes, Map.<String, EdgeLayout>of());
    }

    private static NodeLayout at(int x, int y) {
        return new NodeLayout(new Point(x, y), null, Map.of());
    }

    private GenerateSampleData() { }
}
