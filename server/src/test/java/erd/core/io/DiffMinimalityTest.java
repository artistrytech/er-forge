package erd.core.io;

import erd.core.fixtures.FixtureModels;
import erd.core.model.Column;
import erd.core.model.DiagramPage;
import erd.core.model.LogicalType;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
import erd.core.model.Table;
import erd.core.model.TableSchema;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** INV-5: 1つの変更 = 1行の差分（T-7 / T-8 / T-9）。 */
class DiffMinimalityTest {

    private final DataFilePrinter printer = new DataFilePrinter();

    @Test
    @DisplayName("T-7: カラムの型を1つ変更 → 差分が1行")
    void changeColumnType() {
        Table before = FixtureModels.usersTable();
        List<Column> columns = new ArrayList<>(before.schema().columns());
        Column email = columns.get(1);
        columns.set(1, new Column(email.name(), "varchar(512)", email.logicalType(), email.nullable(),
                email.defaultValue(), email.autoIncrement(), email.generated(), email.comment(), email.unknown()));
        Table after = before.withSchema(withColumns(before.schema(), columns));

        assertSingleLineChanged(printer.printTable(before), printer.printTable(after));
    }

    @Test
    @DisplayName("T-8: カラムを末尾に1つ追加 → 差分が1行（末尾カンマの効果）")
    void appendColumn() {
        Table before = FixtureModels.usersTable();
        List<Column> columns = new ArrayList<>(before.schema().columns());
        columns.add(new Column("deleted_at", "timestamptz", LogicalType.DATETIME, true));
        Table after = before.withSchema(withColumns(before.schema(), columns));

        String[] a = printer.printTable(before).split("\n", -1);
        String[] b = printer.printTable(after).split("\n", -1);
        assertEquals(a.length + 1, b.length, "行数がちょうど1行増えること");
        // 追加行以外はすべて一致する（先頭からの共通 + 末尾からの共通 = 元の行数）
        int prefix = 0;
        while (prefix < a.length && a[prefix].equals(b[prefix])) prefix++;
        int suffix = 0;
        while (suffix < a.length - prefix
                && a[a.length - 1 - suffix].equals(b[b.length - 1 - suffix])) suffix++;
        assertEquals(a.length, prefix + suffix, "既存の行が書き換わっていないこと");
    }

    @Test
    @DisplayName("T-9: ノードを1つ動かす → 差分が1行（nodes はテーブルID昇順で行が移動しない）")
    void moveNode() {
        DiagramPage before = FixtureModels.coreDiagram();
        Map<String, NodeLayout> nodes = new LinkedHashMap<>(before.nodes());
        NodeLayout users = nodes.get("public.users");
        nodes.put("public.users", new NodeLayout(new Point(200, 160), users.w(), users.unknown()));
        DiagramPage after = new DiagramPage(before.id(), before.title(), before.order(),
                nodes, before.edges(), before.unknown());

        assertSingleLineChanged(printer.printDiagram(before), printer.printDiagram(after));
    }

    private static TableSchema withColumns(TableSchema s, List<Column> columns) {
        return new TableSchema(s.name(), s.schema(), s.comment(), columns, s.primaryKey(),
                s.uniques(), s.indexes(), s.foreignKeys(), s.dialect());
    }

    private static void assertSingleLineChanged(String before, String after) {
        String[] a = before.split("\n", -1);
        String[] b = after.split("\n", -1);
        assertEquals(a.length, b.length, "行数が変わらないこと");
        int changed = 0;
        for (int i = 0; i < a.length; i++) {
            if (!a[i].equals(b[i])) changed++;
        }
        assertEquals(1, changed, "差分がちょうど1行であること");
    }
}
