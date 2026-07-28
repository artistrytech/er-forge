package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import erd.core.diff.DiffItem;
import erd.core.io.ProjectStore;
import erd.core.model.DiagramPage;
import erd.core.model.Dictionary;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
import erd.core.model.ProjectConfig;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.introspect.IntrospectOptions;
import erd.introspect.JdbcIntrospector;
import erd.introspect.RawSchema;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 逆生成の end-to-end（H2 → プレビュー → 適用 → ファイル）。
 *
 * <p>INV-4（プレビューは1バイトも書かない）・INV-2（diagrams を触らない）・
 * INV-1（meta を保持する）を、実際のファイル入出力を通して検証する。
 */
class IntrospectServiceTest {

    private static final String DDL = """
            CREATE SCHEMA IF NOT EXISTS "public";
            CREATE TABLE "public"."users" (
              "id" BIGINT AUTO_INCREMENT PRIMARY KEY,
              "email" VARCHAR(255) NOT NULL
            );
            COMMENT ON TABLE "public"."users" IS 'ユーザーマスタ';
            CREATE TABLE "public"."orders" (
              "id" BIGINT AUTO_INCREMENT PRIMARY KEY,
              "user_id" BIGINT NOT NULL,
              CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id")
                REFERENCES "public"."users"("id")
            );
            COMMENT ON TABLE "public"."orders" IS '注文';
            """;

    private final ObjectMapper mapper = new ObjectMapper();
    private final IntrospectService service = new IntrospectService();
    private final ProjectStore store = new ProjectStore();

    private String url(String name) {
        return "jdbc:h2:mem:" + name + ";DB_CLOSE_DELAY=-1";
    }

    private Connection db(String name) throws Exception {
        Connection conn = DriverManager.getConnection(url(name));
        try (Statement st = conn.createStatement()) {
            st.execute(DDL);
        }
        return conn;
    }

    /** DB の現状から data/** の初期状態を作る（逆生成で作られた直後の状態を模す）。 */
    private void writeInitialData(Path dataDir, Connection conn) throws Exception {
        RawSchema raw = new JdbcIntrospector().introspect(conn,
                new IntrospectOptions("public", List.of(), List.of()));
        List<Table> tables = new ArrayList<>();
        for (var schema : raw.tables()) {
            tables.add(new Table(RawSchema.idOf(schema), schema, TableMeta.EMPTY));
        }
        Map<String, NodeLayout> nodes = new LinkedHashMap<>();
        nodes.put("public.users", new NodeLayout(new Point(120, 80)));
        nodes.put("public.orders", new NodeLayout(new Point(520, 80)));
        DiagramPage page = new DiagramPage("core", "コア", 1, nodes, Map.of());
        Manifest manifest = new Manifest(1,
                "config.js", "dictionary.js",
                Map.of(), List.of(), Map.of());
        store.writeAll(dataDir, new ProjectModel(manifest, ProjectConfig.EMPTY, Dictionary.EMPTY,
                tables, List.of(page)));
    }

    private ObjectNode request(String name) {
        ObjectNode body = mapper.createObjectNode();
        ObjectNode connection = body.putObject("connection");
        connection.put("url", url(name));
        ObjectNode scope = body.putObject("scope");
        scope.put("namespace", "public");
        return body;
    }

    /** テストのワークスペース（セッションの帰属先。ここでは1つしか使わない） */
    private static final String WS = "default";

    @SuppressWarnings("unchecked")
    private Map<String, Object> preview(Path erdDir, Path dataDir, String name) throws Exception {
        IntrospectService.Outcome outcome = service.preview(WS, erdDir, dataDir, request(name));
        IntrospectService.Ok ok = assertInstanceOf(IntrospectService.Ok.class, outcome);
        return (Map<String, Object>) ok.body();
    }

    @SuppressWarnings("unchecked")
    private static List<String> selectableIds(Map<String, Object> preview) {
        List<String> ids = new ArrayList<>();
        collect((List<DiffItem>) preview.get("items"), ids);
        return ids;
    }

    private static void collect(List<DiffItem> items, List<String> out) {
        for (DiffItem item : items) {
            if (item.selectable()) out.add(item.id());
            collect(item.children(), out);
        }
    }

    private ObjectNode applyBody(Map<String, Object> preview, List<String> selection) {
        ObjectNode body = mapper.createObjectNode();
        body.put("sessionId", (String) preview.get("sessionId"));
        body.put("confirmed", true);
        ArrayNode arr = body.putArray("selection");
        selection.forEach(arr::add);
        body.putArray("renameDecisions");
        return body;
    }

    @Test
    @DisplayName("T-15 / INV-4: プレビューは data/** に1バイトも書き込まない")
    void previewWritesNothing(@TempDir Path root) throws Exception {
        Path dataDir = root.resolve("data");
        try (Connection conn = db("svc1")) {
            writeInitialData(dataDir, conn);
            String before = Hashes.fingerprint(dataDir);

            preview(root.resolve(".erd"), dataDir, "svc1");

            assertEquals(before, Hashes.fingerprint(dataDir));
        }
    }

    @Test
    @DisplayName("K-14 / T-3: 論理名を補完しても diagrams は1バイトも変わらない（INV-2）")
    void applySeedsNamesAndLeavesDiagramsAlone(@TempDir Path root) throws Exception {
        Path dataDir = root.resolve("data");
        try (Connection conn = db("svc2")) {
            writeInitialData(dataDir, conn);
            Path diagram = dataDir.resolve("diagrams/core.js");
            String diagramHash = Hashes.sha256(diagram);
            long diagramMtime = Files.getLastModifiedTime(diagram).toMillis();

            Map<String, Object> preview = preview(root.resolve(".erd"), dataDir, "svc2");
            List<String> ids = selectableIds(preview);
            assertTrue(ids.contains("table:public.users/displayName"));

            IntrospectService.Outcome outcome = service.apply(WS, root.resolve(".erd"), dataDir,
                    applyBody(preview, ids));
            assertInstanceOf(IntrospectService.Ok.class, outcome);

            // コメントの1行目が論理名の初期値として書かれる（K-14）
            ProjectModel model = store.read(dataDir).model();
            assertEquals("ユーザーマスタ", model.table("public.users").orElseThrow()
                    .meta().displayName());
            assertEquals("注文", model.table("public.orders").orElseThrow().meta().displayName());

            // diagrams は内容もタイムスタンプも変わらない
            assertEquals(diagramHash, Hashes.sha256(diagram));
            assertEquals(diagramMtime, Files.getLastModifiedTime(diagram).toMillis());

            // 適用後に再度プレビューすると差分ゼロ（T-1 の end-to-end）
            Map<String, Object> again = preview(root.resolve(".erd"), dataDir, "svc2");
            assertTrue(selectableIds(again).isEmpty());
        }
    }

    @Test
    @DisplayName("T-2 / INV-1: カラム追加を適用しても人が書いた meta は変わらない")
    void applyPreservesMeta(@TempDir Path root) throws Exception {
        Path dataDir = root.resolve("data");
        try (Connection conn = db("svc3")) {
            writeInitialData(dataDir, conn);

            // 人が論理名・注記・タグを整備した状態にする
            ProjectModel model = store.read(dataDir).model();
            Table users = model.table("public.users").orElseThrow();
            Table enriched = users.withMeta(new TableMeta("ユーザー", List.of("core"), "blue",
                    "論理削除は deleted_at 運用", Map.of(), List.of(), List.of(), Map.of(), Map.of()));
            List<Table> tables = model.tables().stream()
                    .map(t -> t.id().equals("public.users") ? enriched : t).toList();
            store.writeAll(dataDir, new ProjectModel(model.manifest(), model.config(),
                    model.dictionary(), tables, model.diagrams()));

            try (Statement st = conn.createStatement()) {
                st.execute("ALTER TABLE \"public\".\"users\" ADD COLUMN \"nickname\" VARCHAR(64)");
            }

            Map<String, Object> preview = preview(root.resolve(".erd"), dataDir, "svc3");
            IntrospectService.Outcome outcome = service.apply(WS, root.resolve(".erd"), dataDir,
                    applyBody(preview, selectableIds(preview)));
            assertInstanceOf(IntrospectService.Ok.class, outcome);

            Table applied = store.read(dataDir).model().table("public.users").orElseThrow();
            assertEquals(enriched.meta(), applied.meta());   // 論理名は上書きされない（T-14）
            assertEquals(3, applied.schema().columns().size());
        }
    }

    @Test
    @DisplayName("T-8: プレビュー後に data/** が外部から変わっていたら 409 で拒否し、書き込まない")
    void staleFingerprintIsRejected(@TempDir Path root) throws Exception {
        Path dataDir = root.resolve("data");
        try (Connection conn = db("svc4")) {
            writeInitialData(dataDir, conn);
            Map<String, Object> preview = preview(root.resolve(".erd"), dataDir, "svc4");

            // git pull / エディタでの直接編集を模す
            Path file = dataDir.resolve("dictionary.js");
            Files.writeString(file, "ERD.dictionary({\n  columns: {\n    id: \"ID\",\n  },\n});\n");
            String after = Hashes.fingerprint(dataDir);

            IntrospectService.Outcome outcome = service.apply(WS, root.resolve(".erd"), dataDir,
                    applyBody(preview, selectableIds(preview)));

            assertInstanceOf(IntrospectService.Stale.class, outcome);
            assertEquals(after, Hashes.fingerprint(dataDir));   // 1バイトも書いていない
        }
    }

    @Test
    @DisplayName("テーブル削除を適用すると schema ファイルが消え、ノードは孤児として残る（K-13）")
    void removedTableLeavesOrphanNode(@TempDir Path root) throws Exception {
        Path dataDir = root.resolve("data");
        try (Connection conn = db("svc5")) {
            writeInitialData(dataDir, conn);
            try (Statement st = conn.createStatement()) {
                st.execute("DROP TABLE \"public\".\"orders\"");
            }

            Map<String, Object> preview = preview(root.resolve(".erd"), dataDir, "svc5");
            IntrospectService.Outcome outcome = service.apply(WS, root.resolve(".erd"), dataDir,
                    applyBody(preview, selectableIds(preview)));
            IntrospectService.Ok ok = assertInstanceOf(IntrospectService.Ok.class, outcome);

            assertFalse(Files.exists(dataDir.resolve("schema/public/orders.js")));
            assertTrue(Files.exists(dataDir.resolve("schema/public/users.js")));

            // ER図のノードは自動削除しない（配置は DB から復元できない human-owned な情報）
            ProjectModel model = store.read(dataDir).model();
            assertTrue(model.diagrams().get(0).nodes().containsKey("public.orders"));

            @SuppressWarnings("unchecked")
            Map<String, Object> body = (Map<String, Object>) ok.body();
            assertEquals(1, ((List<?>) body.get("orphanNodes")).size());

            // 適用前バックアップ（§8.5）が残っている
            assertTrue(Files.isDirectory(root.resolve(".erd/backup")));
        }
    }
}
