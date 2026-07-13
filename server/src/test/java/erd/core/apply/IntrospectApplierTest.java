package erd.core.apply;

import erd.core.diff.DiffPlan;
import erd.core.diff.PatternList;
import erd.core.diff.RenameDecision;
import erd.core.diff.SchemaDiff;
import erd.core.fixtures.DiffFixtures;
import erd.core.fixtures.FixtureModels;
import erd.core.model.Column;
import erd.core.model.DiagramPage;
import erd.core.model.LogicalType;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableSchema;
import erd.introspect.RawSchema;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 適用（K-11 / 詳細設計 §6）。
 *
 * <p>ここでの検証は「DB の変更を取り込みながら、人が書いた情報を1文字も失わない」という
 * 本機能の存在意義そのものである（INV-1 / INV-2）。
 */
class IntrospectApplierTest {

    private final SchemaDiff diff = new SchemaDiff();
    private final IntrospectApplier applier = new IntrospectApplier();

    private ApplyResult apply(ProjectModel model, RawSchema raw, List<RenameDecision> decisions) {
        DiffPlan plan = diff.plan(model, raw, PatternList.EMPTY, decisions);
        return applier.apply(model, raw, plan, DiffFixtures.selectAll(plan));
    }

    @Test
    @DisplayName("T-2: カラム追加を適用しても meta（論理名・論理制約・注記）が1文字も変わらない（INV-1）")
    void metaSurvivesSchemaChange() {
        TableSchema users = DiffFixtures.addColumn(FixtureModels.usersTable().schema(),
                new Column("nickname", "varchar(64)", LogicalType.STRING, true));
        RawSchema raw = DiffFixtures.raw(users, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());

        ApplyResult result = apply(DiffFixtures.model(), raw, List.of());

        Table applied = DiffFixtures.table(result.model(), "public.users");
        assertEquals(FixtureModels.usersTable().meta(), applied.meta());
        assertEquals(6, applied.schema().columns().size());
        assertEquals(1, result.applied().modified());
    }

    @Test
    @DisplayName("T-3: リネームが無ければ diagrams は一切変わらない（INV-2）")
    void diagramsUntouched() {
        TableSchema users = DiffFixtures.addColumn(FixtureModels.usersTable().schema(),
                new Column("nickname", "varchar(64)", LogicalType.STRING, true));
        RawSchema raw = DiffFixtures.raw(users, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());

        ApplyResult result = apply(DiffFixtures.model(), raw, List.of());

        assertEquals(List.of(FixtureModels.coreDiagram()), result.model().diagrams());
    }

    @Test
    @DisplayName("T-4: テーブルリネームの承認で id・参照・ER図のキーが追随し、座標は変わらない")
    void acceptedTableRename() {
        TableSchema renamed = DiffFixtures.renamed(FixtureModels.organizationsTable().schema(), "orgs");
        // DB 側の users.FK は新しいテーブル名を参照している
        TableSchema users = FixtureModels.usersTable().schema();
        TableSchema usersNew = new TableSchema(users.name(), users.schema(), users.comment(),
                users.columns(), users.primaryKey(), users.uniques(), users.indexes(),
                List.of(new erd.core.model.ForeignKey("users_org_id_fkey", List.of("org_id"),
                        new erd.core.model.Ref("public.orgs", List.of("id")), "set null", null)),
                users.dialect());
        RawSchema raw = DiffFixtures.raw(usersNew, FixtureModels.ordersTable().schema(), renamed);
        List<RenameDecision> decisions = List.of(
                new RenameDecision("rename:public.organizations->public.orgs", "accept", null));

        ApplyResult result = apply(DiffFixtures.model(), raw, decisions);

        // スキーマ: 新しい ID で存在し、旧 ID は消える。meta（論理名「組織」）は引き継がれる
        Table orgs = DiffFixtures.table(result.model(), "public.orgs");
        assertEquals("組織", orgs.meta().displayName());
        assertTrue(result.model().table("public.organizations").isEmpty());

        // 他テーブルの参照が追随する
        assertEquals("public.orgs",
                DiffFixtures.table(result.model(), "public.users")
                        .schema().foreignKeys().get(0).ref().table());

        // ER図: ノードのキーが書き換わり、座標は変わらない（INV-2）
        DiagramPage page = result.model().diagrams().get(0);
        assertTrue(page.nodes().containsKey("public.orgs"));
        assertFalse(page.nodes().containsKey("public.organizations"));
        assertEquals(FixtureModels.coreDiagram().nodes().get("public.organizations").pos(),
                page.nodes().get("public.orgs").pos());
        assertEquals(1, result.applied().renamed());
    }

    @Test
    @DisplayName("T-5: リネームを却下すると削除 + 追加になり、meta は失われる（警告済み）")
    void rejectedTableRename() {
        TableSchema renamed = DiffFixtures.renamed(FixtureModels.organizationsTable().schema(), "orgs");
        TableSchema users = FixtureModels.usersTable().schema();
        TableSchema usersNew = new TableSchema(users.name(), users.schema(), users.comment(),
                users.columns(), users.primaryKey(), users.uniques(), users.indexes(),
                List.of(new erd.core.model.ForeignKey("users_org_id_fkey", List.of("org_id"),
                        new erd.core.model.Ref("public.orgs", List.of("id")), "set null", null)),
                users.dialect());
        RawSchema raw = DiffFixtures.raw(usersNew, FixtureModels.ordersTable().schema(), renamed);
        List<RenameDecision> decisions = List.of(
                new RenameDecision("rename:public.organizations->public.orgs", "reject", null));

        // 人が積み上げた meta（タグ・注記）を持たせ、却下でそれが失われることを確認する
        Table orgTable = FixtureModels.organizationsTable();
        Table enriched = orgTable.withMeta(new erd.core.model.TableMeta("組織", List.of("core"),
                "マスタ", Map.of(), List.of(), List.of(), Map.of(), Map.of()));
        ProjectModel model = new ProjectModel(FixtureModels.manifest(),
                erd.core.model.ProjectConfig.EMPTY, FixtureModels.dictionary(),
                List.of(FixtureModels.usersTable(), FixtureModels.ordersTable(), enriched),
                List.of(FixtureModels.coreDiagram()));

        ApplyResult result = apply(model, raw, decisions);

        Table orgs = DiffFixtures.table(result.model(), "public.orgs");
        assertTrue(orgs.meta().tags().isEmpty());     // タグ・注記は失われる（新規テーブル扱い）
        assertEquals(null, orgs.meta().notes());
        assertTrue(result.model().table("public.organizations").isEmpty());

        // K-13: 旧テーブルのノードは孤児として残る（自動削除しない）
        assertEquals(1, result.orphanNodes().size());
        assertEquals("public.organizations", result.orphanNodes().get(0).tableId());
        assertEquals(List.of("core"), result.orphanNodes().get(0).diagrams());
        // K-12: 新しいテーブルは未配置トレイに入る
        assertEquals(List.of("public.orgs"), result.unplacedTables());
    }

    @Test
    @DisplayName("T-6: カラムリネームの承認で meta.columns のキーが付け替わり、論理名・注記が残る")
    void acceptedColumnRename() {
        TableSchema users = FixtureModels.usersTable().schema();
        List<Column> columns = users.columns().stream()
                .map(c -> c.name().equals("org_id")
                        ? new Column("organization_id", "int8", LogicalType.INT, true)
                        : c)
                .toList();
        TableSchema usersNew = new TableSchema(users.name(), users.schema(), users.comment(), columns,
                users.primaryKey(), users.uniques(), users.indexes(),
                List.of(new erd.core.model.ForeignKey("users_org_id_fkey", List.of("organization_id"),
                        new erd.core.model.Ref("public.organizations", List.of("id")), "set null", null)),
                users.dialect());
        RawSchema raw = DiffFixtures.raw(usersNew, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());
        List<RenameDecision> decisions = List.of(new RenameDecision(
                "rename:public.users.org_id->public.users.organization_id", "accept", null));

        ApplyResult result = apply(DiffFixtures.model(), raw, decisions);

        Table applied = DiffFixtures.table(result.model(), "public.users");
        var cm = applied.meta().columns().get("organization_id");
        assertNotNull(cm);
        assertEquals("所属組織ID", cm.displayName());
        assertEquals("NULL は個人アカウント", cm.notes());
        assertFalse(applied.meta().columns().containsKey("org_id"));
        // 論理一意制約のカラム名も追随する
        assertEquals(List.of("organization_id", "email"),
                applied.meta().logicalUniques().get(0).columns());
    }

    @Test
    @DisplayName("T-13 / T-14: 論理名を補完するのは未設定のときだけ。既存値は上書きしない")
    void seedsLogicalNames() {
        // orders の displayName を消し、コメントから補完されることを確認する
        Table orders = FixtureModels.ordersTable();
        var meta = orders.meta();
        Table noName = orders.withMeta(new erd.core.model.TableMeta(null, meta.tags(), meta.notes(),
                meta.columns(), meta.logicalUniques(), meta.logicalForeignKeys(), meta.relations(),
                meta.unknown()));
        ProjectModel model = new ProjectModel(FixtureModels.manifest(),
                erd.core.model.ProjectConfig.EMPTY, FixtureModels.dictionary(),
                List.of(FixtureModels.usersTable(), noName, FixtureModels.organizationsTable()),
                List.of(FixtureModels.coreDiagram()));

        ApplyResult result = apply(model, DiffFixtures.sameAsModel(), List.of());

        assertEquals("注文", DiffFixtures.table(result.model(), "public.orders").meta().displayName());
        // users は「ユーザー」のまま（コメント「ユーザーマスタ」で上書きされない）
        assertEquals("ユーザー", DiffFixtures.table(result.model(), "public.users").meta().displayName());
        assertEquals(1, result.seededTables());
    }

    @Test
    @DisplayName("K-10: 部分適用。選択しなかった差分は既存の定義のまま残る")
    void partialApply() {
        TableSchema users = DiffFixtures.dropColumn(
                DiffFixtures.addColumn(FixtureModels.usersTable().schema(),
                        new Column("nickname", "varchar(64)", LogicalType.STRING, true)),
                "last_order_id");
        RawSchema raw = DiffFixtures.raw(users, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());
        ProjectModel model = DiffFixtures.model();
        DiffPlan plan = diff.plan(model, raw, PatternList.EMPTY, List.of());

        // 追加だけを適用し、削除は見送る
        Set<String> selection = new LinkedHashSet<>(List.of("table:public.users/column:nickname"));
        ApplyResult result = applier.apply(model, raw, plan, selection);

        List<String> names = DiffFixtures.table(result.model(), "public.users").schema().columns()
                .stream().map(Column::name).toList();
        assertTrue(names.contains("nickname"));
        assertTrue(names.contains("last_order_id"));   // 削除を適用していないので残る
        assertTrue(result.skipped().contains("table:public.users/column:last_order_id"));
    }

    @Test
    @DisplayName("T-9 / R-3: 参照先テーブルの追加を選ばずに FK 追加だけを選ぶと 依存性違反")
    void dependencyViolation() {
        TableSchema invoices = new TableSchema("invoices", "public", null,
                List.of(new Column("id", "bigserial", LogicalType.INT, false, null, true, false, null,
                        Map.of())),
                List.of("id"), List.of(), List.of(), List.of(), Map.of());
        TableSchema orders = FixtureModels.ordersTable().schema();
        TableSchema ordersWithFk = new TableSchema(orders.name(), orders.schema(), orders.comment(),
                DiffFixtures.addColumn(orders,
                        new Column("invoice_id", "int8", LogicalType.INT, true)).columns(),
                orders.primaryKey(), orders.uniques(), orders.indexes(),
                List.of(orders.foreignKeys().get(0),
                        new erd.core.model.ForeignKey("orders_invoice_id_fkey", List.of("invoice_id"),
                                new erd.core.model.Ref("public.invoices", List.of("id")), null, null)),
                orders.dialect());
        RawSchema raw = DiffFixtures.raw(FixtureModels.usersTable().schema(), ordersWithFk,
                FixtureModels.organizationsTable().schema(), invoices);
        ProjectModel model = DiffFixtures.model();
        DiffPlan plan = diff.plan(model, raw, PatternList.EMPTY, List.of());

        Set<String> selection = new LinkedHashSet<>(List.of(
                "table:public.orders/column:invoice_id",
                "table:public.orders/fk:orders_invoice_id_fkey"));   // invoices の追加を選んでいない

        DependencyException e = assertThrows(DependencyException.class,
                () -> applier.apply(model, raw, plan, selection));
        assertTrue(e.itemIds().contains("table:public.orders/fk:orders_invoice_id_fkey"));
    }

    @Test
    @DisplayName("R-4: テーブル削除を適用すると、それを参照する FK の削除も強制的に適用される")
    void removingTableDropsReferencingFk() {
        // DB から organizations が消え、users の FK も消えた
        TableSchema users = FixtureModels.usersTable().schema();
        TableSchema usersNoFk = new TableSchema(users.name(), users.schema(), users.comment(),
                users.columns(), users.primaryKey(), users.uniques(), users.indexes(),
                List.of(), users.dialect());
        RawSchema raw = DiffFixtures.raw(usersNoFk, FixtureModels.ordersTable().schema());
        ProjectModel model = DiffFixtures.model();
        DiffPlan plan = diff.plan(model, raw, PatternList.EMPTY, List.of());

        // テーブル削除だけを選択する（FK 削除は selectable = false）
        ApplyResult result = applier.apply(model, raw, plan,
                new LinkedHashSet<>(List.of("table:public.organizations")));

        assertTrue(result.model().table("public.organizations").isEmpty());
        assertTrue(DiffFixtures.table(result.model(), "public.users").schema().foreignKeys().isEmpty());
    }
}
