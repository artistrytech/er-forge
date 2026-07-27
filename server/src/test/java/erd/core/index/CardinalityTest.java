package erd.core.index;

import erd.core.fixtures.FixtureModels;
import erd.core.model.Column;
import erd.core.model.ForeignKey;
import erd.core.model.LogicalType;
import erd.core.model.LogicalUnique;
import erd.core.model.Ref;
import erd.core.model.Table;
import erd.core.model.TableMeta;
import erd.core.model.TableSchema;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** カーディナリティの解決（Phase0 詳細設計 §5、T-12〜T-14）。 */
class CardinalityTest {

    private final IndexGenerator generator = new IndexGenerator();

    private static Table parentTable() {
        return new Table("public.profiles_parent", new TableSchema(
                "profiles_parent", "public", null,
                List.of(new Column("id", "int4", LogicalType.INT, false)),
                List.of("id"), List.of(), List.of(), List.of(), Map.of()),
                TableMeta.EMPTY);
    }

    @Test
    @DisplayName("T-12: FK カラムが NOT NULL + ユニーク → parent 1..1 / child 0..1")
    void notNullUniqueFk() {
        // profiles.user_id は NOT NULL かつ UNIQUE（1対1の典型）
        Table profiles = new Table("public.profiles", new TableSchema(
                "profiles", "public", null,
                List.of(
                        new Column("id", "int4", LogicalType.INT, false),
                        new Column("user_id", "int4", LogicalType.INT, false)),
                List.of("id"),
                List.of(new erd.core.model.UniqueConstraint("profiles_user_id_key", List.of("user_id"))),
                List.of(),
                List.of(new ForeignKey("profiles_user_id_fkey", List.of("user_id"),
                        new Ref("public.profiles_parent", List.of("id")), null, null)),
                Map.of()), TableMeta.EMPTY);

        IndexModel index = generator.generate(List.of(profiles, parentTable()), List.of());
        IndexModel.RelationEntry r = index.relations().get(0);
        assertEquals("1..1", r.cardinality().parent());
        assertEquals("0..1", r.cardinality().child());
        assertTrue(r.explicit().isEmpty(), "導出値のみなら explicit は空");
    }

    @Test
    @DisplayName("T-13: meta.relations の child: 1..N が反映され、explicit が付く")
    void explicitOverride() {
        IndexModel index = FixtureModels.indexModel();
        IndexModel.RelationEntry r = index.relations().stream()
                .filter(x -> x.id().equals("public.users#fk:users_org_id_fkey"))
                .findFirst().orElseThrow();
        assertEquals("0..1", r.cardinality().parent(), "org_id は NULL 可 → 導出値 0..1");
        assertEquals("1..N", r.cardinality().child(), "meta.relations の上書きが勝つ");
        assertEquals(List.of("child"), r.explicit());
    }

    @Test
    @DisplayName("T-14: 論理一意制約を FK カラムに追加すると child が 0..N → 0..1 に変わる")
    void logicalUniqueChangesChild() {
        Table orders = FixtureModels.ordersTable();
        IndexModel before = generator.generate(
                List.of(orders, FixtureModels.usersTable(), FixtureModels.organizationsTable()), List.of());
        IndexModel.RelationEntry beforeRel = before.relations().stream()
                .filter(x -> x.id().equals("public.orders#fk:orders_user_id_fkey"))
                .findFirst().orElseThrow();
        assertEquals("0..N", beforeRel.cardinality().child());

        // user_id に論理一意制約を追加（1ユーザー1注文の業務ルール）
        TableMeta m = orders.meta();
        TableMeta withLu = new TableMeta(m.displayName(), m.tags(), m.color(), m.notes(), m.columns(),
                List.of(new LogicalUnique("luk_orders_user", List.of("user_id"), "1ユーザー1注文")),
                m.logicalForeignKeys(), m.relations(), m.unknown());
        IndexModel after = generator.generate(
                List.of(orders.withMeta(withLu), FixtureModels.usersTable(),
                        FixtureModels.organizationsTable()), List.of());
        IndexModel.RelationEntry afterRel = after.relations().stream()
                .filter(x -> x.id().equals("public.orders#fk:orders_user_id_fkey"))
                .findFirst().orElseThrow();
        assertEquals("0..1", afterRel.cardinality().child(), "index.js の再生成で反映される");
    }

    @Test
    @DisplayName("参照先が存在しないリレーションは dangling: true で index に残る")
    void danglingRelation() {
        IndexModel index = FixtureModels.indexModel();
        IndexModel.RelationEntry r = index.relations().stream()
                .filter(x -> x.id().equals("public.orders#lfk:lfk_orders_legacy"))
                .findFirst().orElseThrow();
        assertTrue(r.dangling(), "public.legacy_orders は存在しない → dangling");
        assertEquals("logical", r.kind());
    }
}
