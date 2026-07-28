package erd.core.diff;

import erd.core.fixtures.DiffFixtures;
import erd.core.fixtures.FixtureModels;
import erd.core.model.Column;
import erd.core.model.LogicalType;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import erd.introspect.RawSchema;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 差分計算（K-08 / 詳細設計 §2・§8.5）。 */
class SchemaDiffTest {

    private final SchemaDiff diff = new SchemaDiff();

    @Test
    @DisplayName("T-1: 同じスキーマを2回内省したら差分ゼロ")
    void noDiffForIdenticalSchema() {
        DiffPlan plan = diff.plan(DiffFixtures.model(), DiffFixtures.sameAsModel(),
                PatternList.EMPTY, List.of());

        assertEquals(0, plan.stats().added());
        assertEquals(0, plan.stats().removed());
        assertEquals(0, plan.stats().modified());
        assertEquals(3, plan.stats().unchanged());
        assertTrue(plan.items().isEmpty());
    }

    @Test
    @DisplayName("追加・削除・変更がツリーとして出る")
    void detectsAddedRemovedModified() {
        TableSchema users = DiffFixtures.addColumn(FixtureModels.usersTable().schema(),
                new Column("nickname", "varchar(64)", LogicalType.STRING, true));
        TableSchema invoices = new TableSchema("invoices", "public", null,
                List.of(new Column("id", "bigserial", LogicalType.INT, false, null, true, false, null,
                        Map.of())),
                List.of("id"), List.of(), List.of(), List.of(), Map.of());
        // organizations は DB から消えた（削除候補）
        RawSchema raw = DiffFixtures.raw(users, FixtureModels.ordersTable().schema(), invoices);

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        assertEquals(1, plan.stats().added());
        assertEquals(1, plan.stats().removed());
        assertEquals(1, plan.stats().modified());

        DiffItem usersItem = plan.index().get("table:public.users");
        assertEquals("modified", usersItem.change());
        assertEquals("added", plan.index().get("table:public.users/column:nickname").change());

        // 削除されたテーブルはページに配置されており、孤児になることを警告する（§3.2）
        DiffItem orgs = plan.index().get("table:public.organizations");
        assertTrue(orgs.warnings().stream().anyMatch(w -> w.code().equals("ORPHAN_NODES")));
    }

    @Test
    @DisplayName("削除カラムに論理名・論理制約があれば「失われるもの」を警告する（§3.2）")
    void warnsAboutLostColumnMeta() {
        // DB 側で org_id カラムが消え、それを使う FK も消えた
        TableSchema base = DiffFixtures.dropColumn(FixtureModels.usersTable().schema(), "org_id");
        TableSchema users = new TableSchema(base.name(), base.schema(), base.comment(), base.columns(),
                base.primaryKey(), base.uniques(), base.indexes(), List.of(), base.dialect());
        RawSchema raw = DiffFixtures.raw(users, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        DiffItem column = plan.index().get("table:public.users/column:org_id");
        assertEquals("removed", column.change());
        assertTrue(column.warnings().stream().anyMatch(w -> w.code().equals("LOST_COLUMN_META")));
        assertTrue(column.warnings().stream().anyMatch(w -> w.code().equals("LOST_LOGICAL_UNIQUE")));

        // R-6: そのカラムを含む制約の削除は外せない（selectable = false）
        DiffItem fk = plan.index().get("table:public.users/fk:users_org_id_fkey");
        assertEquals("removed", fk.change());
        assertFalse(fk.selectable());
        assertEquals(List.of("table:public.users/column:org_id"), fk.forcedBy());
    }

    @Test
    @DisplayName("T-11: 無視リストにマッチするテーブルは追加候補にも削除候補にもならない（双方向。INV-6）")
    void ignoreListWorksBothWays() {
        // 既存側: 手動定義テーブル（DB に存在しない）。DB 側: 管理テーブル
        Table manual = new Table("public.design_draft",
                new TableSchema("design_draft", "public", null,
                        List.of(new Column("id", "int4", LogicalType.INT, false)),
                        List.of("id"), List.of(), List.of(), List.of(), Map.of()),
                TableMeta.EMPTY);
        ProjectModel model = DiffFixtures.model();
        List<Table> tables = new java.util.ArrayList<>(model.tables());
        tables.add(manual);
        model = new ProjectModel(model.manifest(), model.config(), model.dictionary(), tables,
                model.diagrams());

        TableSchema flyway = new TableSchema("flyway_schema_history", "public", null,
                List.of(new Column("installed_rank", "int4", LogicalType.INT, false)),
                List.of("installed_rank"), List.of(), List.of(), List.of(), Map.of());
        RawSchema raw = DiffFixtures.raw(FixtureModels.usersTable().schema(),
                FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema(), flyway);

        PatternList ignore = PatternList.of(List.of("public.flyway_schema_history", "public.design_*"));
        DiffPlan plan = diff.plan(model, raw, ignore, List.of());

        assertEquals(0, plan.stats().added());
        assertEquals(0, plan.stats().removed());
        assertEquals(2, plan.stats().ignored());
        assertNull(plan.index().get("table:public.design_draft"));
        assertNull(plan.index().get("table:public.flyway_schema_history"));
    }

    @Test
    @DisplayName("T-13 / T-14: 論理名の初期値補完は未設定のときだけ提示する（K-14）")
    void seedsDisplayNameOnlyWhenUnset() {
        // organizations は displayName「組織」が設定済み → 補完しない
        // users の nickname はコメント付きの新カラム、辞書にも無い → 補完する
        TableSchema users = DiffFixtures.addColumn(FixtureModels.usersTable().schema(),
                new Column("nickname", "varchar(64)", LogicalType.STRING, true, null, false, false,
                        "表示名", Map.of()));
        RawSchema raw = DiffFixtures.raw(users, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        DiffItem seed = plan.index().get("table:public.users/column:nickname/displayName");
        assertNotNull(seed);
        assertEquals("表示名", seed.after());
        // 既存の論理名を持つテーブル・辞書に載っているカラムには種をまかない
        assertNull(plan.index().get("table:public.users/displayName"));
        assertNull(plan.index().get("table:public.users/column:created_at/displayName"));
    }

    @Test
    @DisplayName("T-10 / G-1: 削除が既存の 50% 以上ならガードが発火する")
    void massDeleteGuard() {
        RawSchema raw = DiffFixtures.raw(FixtureModels.usersTable().schema());

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        assertEquals(2, plan.stats().removed());
        assertTrue(plan.guards().stream().anyMatch(g -> g.code().equals("MASS_DELETE")));
    }

    @Test
    @DisplayName("G-2: 内省結果が0件ならガードが発火する")
    void emptyResultGuard() {
        DiffPlan plan = diff.plan(DiffFixtures.model(), DiffFixtures.raw(),
                PatternList.EMPTY, List.of());
        assertTrue(plan.guards().stream().anyMatch(g -> g.code().equals("EMPTY_RESULT")));
    }

    @Test
    @DisplayName("スコープ外のネームスペースは差分の対象にしない")
    void outOfScopeNamespace() {
        ProjectModel model = DiffFixtures.model();
        RawSchema raw = new RawSchema("PostgreSQL", "16.2", "driver", "billing",
                List.of(), List.of());

        DiffPlan plan = diff.plan(model, raw, PatternList.EMPTY, List.of());

        assertEquals(3, plan.stats().outOfScope());
        assertEquals(0, plan.stats().removed());
    }

    @Test
    @DisplayName("K-09: カラム構成が完全一致するテーブルのリネームを確度: 高で検出する")
    void detectsTableRename() {
        TableSchema renamed = DiffFixtures.renamed(FixtureModels.organizationsTable().schema(), "orgs");
        RawSchema raw = DiffFixtures.raw(FixtureModels.usersTable().schema(),
                FixtureModels.ordersTable().schema(), renamed);

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        RenameCandidate c = plan.renameCandidates().get(0);
        assertEquals("table", c.kind());
        assertEquals("public.organizations", c.from());
        assertEquals("public.orgs", c.to());
        assertEquals("high", c.confidence());

        // 未決定の候補は暫定的にリネームとして提示する（削除 + 追加にはしない）
        assertEquals(1, plan.stats().renamed());
        assertEquals(0, plan.stats().added());
        assertEquals(0, plan.stats().removed());
    }

    @Test
    @DisplayName("リネームを却下すると削除 + 追加になる（meta と配置が失われる）")
    void rejectedRenameBecomesAddAndRemove() {
        TableSchema renamed = DiffFixtures.renamed(FixtureModels.organizationsTable().schema(), "orgs");
        RawSchema raw = DiffFixtures.raw(FixtureModels.usersTable().schema(),
                FixtureModels.ordersTable().schema(), renamed);
        List<RenameDecision> decisions = List.of(
                new RenameDecision("rename:public.organizations->public.orgs", "reject", null));

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, decisions);

        assertEquals(0, plan.stats().renamed());
        assertEquals(1, plan.stats().added());
        assertEquals(1, plan.stats().removed());
    }

    @Test
    @DisplayName("K-09: 同一テーブル内のカラムリネームを検出する")
    void detectsColumnRename() {
        TableSchema users = FixtureModels.usersTable().schema();
        List<Column> columns = users.columns().stream()
                .map(c -> c.name().equals("email")
                        ? new Column("mail_address", "varchar(255)", LogicalType.STRING, false)
                        : c)
                .toList();
        // email を参照するユニーク制約も追随する
        TableSchema renamed = new TableSchema(users.name(), users.schema(), users.comment(), columns,
                users.primaryKey(),
                List.of(new erd.core.model.UniqueConstraint("users_email_key", List.of("mail_address"))),
                users.indexes(), users.foreignKeys(), users.dialect());
        RawSchema raw = DiffFixtures.raw(renamed, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        RenameCandidate c = plan.renameCandidates().stream()
                .filter(x -> x.kind().equals("column")).findFirst().orElseThrow();
        assertEquals("email", c.from());
        assertEquals("mail_address", c.to());

        DiffItem column = plan.index().get("table:public.users/column:mail_address");
        assertEquals("renamed", column.change());
        assertEquals("email", column.renamedFrom());
        assertFalse(column.selectable());   // リネームは決定で駆動する（選択ではない）
    }

    @Test
    @DisplayName("R-3: 追加テーブルへの FK 追加は、そのテーブルの追加を requires に持つ")
    void fkAddRequiresReferencedTable() {
        TableSchema invoices = new TableSchema("invoices", "public", null,
                List.of(new Column("id", "bigserial", LogicalType.INT, false, null, true, false, null,
                                Map.of()),
                        new Column("user_id", "int8", LogicalType.INT, false)),
                List.of("id"), List.of(), List.of(),
                List.of(new erd.core.model.ForeignKey("invoices_user_id_fkey", List.of("user_id"),
                        new erd.core.model.Ref("public.users", List.of("id")), null, null)),
                Map.of());
        TableSchema users = FixtureModels.usersTable().schema();
        // orders に「新規テーブル invoices を参照する FK」が増えた
        TableSchema orders = FixtureModels.ordersTable().schema();
        TableSchema ordersWithFk = new TableSchema(orders.name(), orders.schema(), orders.comment(),
                DiffFixtures.addColumn(orders, new Column("invoice_id", "int8", LogicalType.INT, true))
                        .columns(),
                orders.primaryKey(), orders.uniques(), orders.indexes(),
                List.of(orders.foreignKeys().get(0),
                        new erd.core.model.ForeignKey("orders_invoice_id_fkey", List.of("invoice_id"),
                                new erd.core.model.Ref("public.invoices", List.of("id")), null, null)),
                orders.dialect());
        RawSchema raw = DiffFixtures.raw(users, ordersWithFk,
                FixtureModels.organizationsTable().schema(), invoices);

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        DiffItem fk = plan.index().get("table:public.orders/fk:orders_invoice_id_fkey");
        assertTrue(fk.requires().contains("table:public.invoices"));
        assertTrue(fk.requires().contains("table:public.orders/column:invoice_id"));
    }

    // ------------------------------------------------------------ ビュー（K-16 / K-17）

    @Test
    @DisplayName("K-17: 列構成が同じでも種別が違えばリネーム候補にしない")
    void doesNotPairAcrossKinds() {
        // 既存の users テーブルが DB から消え、まったく同じ列を持つビューが現れた状況。
        // カラム構成シグネチャは一致するため、種別を見ないと確度「高」で誤検出される
        TableSchema users = FixtureModels.usersTable().schema();
        TableSchema view = new TableSchema("v_users", "public", "VIEW", users.comment(),
                users.columns(), List.of(), List.of(), List.of(), List.of(), Map.of());
        RawSchema raw = DiffFixtures.raw(view, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        assertTrue(plan.renameCandidates().stream()
                        .noneMatch(c -> "public.users".equals(c.from())),
                "テーブル → ビューはリネームではなく「削除 + 追加」である");
        assertEquals("added", plan.index().get("table:public.v_users").change());
        assertEquals("removed", plan.index().get("table:public.users").change());
    }

    @Test
    @DisplayName("K-17: 種別が同じもの同士ではリネーム候補が出る（抑止は種別またぎだけ）")
    void stillPairsWithinSameKind() {
        TableSchema users = FixtureModels.usersTable().schema();
        TableSchema renamed = new TableSchema("members", "public", users.comment(), users.columns(),
                users.primaryKey(), users.uniques(), users.indexes(), users.foreignKeys(),
                users.dialect());
        RawSchema raw = DiffFixtures.raw(renamed, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        assertTrue(plan.renameCandidates().stream()
                .anyMatch(c -> "public.users".equals(c.from()) && "public.members".equals(c.to())));
    }

    @Test
    @DisplayName("K-16: 種別の変化は差分項目として出る")
    void detectsKindChange() {
        // 同名のオブジェクトがテーブルからビューに置き換わった（DROP TABLE → CREATE VIEW）
        TableSchema users = FixtureModels.usersTable().schema();
        TableSchema asView = new TableSchema(users.name(), users.schema(), "VIEW", users.comment(),
                users.columns(), users.primaryKey(), users.uniques(), users.indexes(),
                users.foreignKeys(), users.dialect());
        RawSchema raw = DiffFixtures.raw(asView, FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());

        DiffPlan plan = diff.plan(DiffFixtures.model(), raw, PatternList.EMPTY, List.of());

        DiffItem kind = plan.index().get("table:public.users/kind");
        assertNotNull(kind);
        assertEquals("objectKind", kind.kind());
        assertEquals("TABLE", kind.before());
        assertEquals("VIEW", kind.after());
        assertTrue(kind.selectable());
    }

    @Test
    @DisplayName("K-16: kind を持たない既存定義を再内省しても差分は出ない（既存プロジェクトの互換性）")
    void noDiffForLegacyModelWithoutKind() {
        // DiffFixtures のモデルは kind を持たない9引数コンストラクタで作られている＝既存データ相当
        DiffPlan plan = diff.plan(DiffFixtures.model(), DiffFixtures.sameAsModel(),
                PatternList.EMPTY, List.of());

        assertTrue(plan.items().stream().flatMap(i -> i.children().stream())
                .noneMatch(c -> "objectKind".equals(c.kind())));
        assertEquals(0, plan.stats().modified());
    }
}
