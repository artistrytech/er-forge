package erd.layout;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AutoLayoutTest {

    private final AutoLayout layout = new AutoLayout();

    private static final List<AutoLayout.Node> NODES = List.of(
            new AutoLayout.Node("public.orders", 200, 44),
            new AutoLayout.Node("public.users", 180, 44),
            new AutoLayout.Node("public.organizations", 220, 44));

    private static final List<AutoLayout.Edge> EDGES = List.of(
            new AutoLayout.Edge("public.users", "public.organizations"),
            new AutoLayout.Edge("public.orders", "public.users"));

    /** ELK のメタデータ（layered）が実行時に発見できること。ここが壊れると座標が返らない。 */
    @Test
    void laysOutEveryNode() {
        Map<String, int[]> pos = layout.layout(NODES, EDGES);

        assertEquals(3, pos.size());
        for (AutoLayout.Node n : NODES) {
            assertNotNull(pos.get(n.id()), n.id() + " の座標が返っていません");
        }
    }

    /** INV-2: 座標は 8px グリッド上の整数（ドラッグ由来と同じ規約。差分ノイズを出さない）。 */
    @Test
    void snapsToGrid() {
        for (int[] p : layout.layout(NODES, EDGES).values()) {
            assertEquals(0, p[0] % 8, "x が 8px グリッド上にありません: " + p[0]);
            assertEquals(0, p[1] % 8, "y が 8px グリッド上にありません: " + p[1]);
        }
    }

    /**
     * 同じページを2回レイアウトして違う座標が出ると、意味のない Git 差分になる。
     * 入力の列挙順に依存しないことまで含めて決定論的であること。
     */
    @Test
    void isDeterministicRegardlessOfInputOrder() {
        Map<String, int[]> a = layout.layout(NODES, EDGES);
        Map<String, int[]> b = layout.layout(reversed(NODES), reversed(EDGES));

        assertEquals(a.keySet(), b.keySet());
        for (String id : a.keySet()) {
            org.junit.jupiter.api.Assertions.assertArrayEquals(a.get(id), b.get(id), id);
        }
    }

    private static <T> List<T> reversed(List<T> list) {
        List<T> copy = new java.util.ArrayList<>(list);
        java.util.Collections.reverse(copy);
        return copy;
    }

    /** リレーションの向き（子 → 親）に沿って層が分かれる。孤立ノードだけの入力でも落ちない。 */
    @Test
    void separatesConnectedNodesIntoLayers() {
        Map<String, int[]> pos = layout.layout(NODES, EDGES);
        assertTrue(pos.get("public.orders")[0] < pos.get("public.organizations")[0],
                "orders → users → organizations の順に層が並ぶはず");

        assertTrue(layout.layout(List.of(), List.of()).isEmpty());
        assertEquals(1, layout.layout(List.of(new AutoLayout.Node("solo", 0, 0)), List.of()).size());
    }

    /** 自己参照 FK と、ページ外テーブルを指すエッジは落とす（レイアウトを壊さない）。 */
    @Test
    void ignoresSelfLoopsAndDanglingEdges() {
        Map<String, int[]> pos = layout.layout(NODES, List.of(
                new AutoLayout.Edge("public.users", "public.users"),
                new AutoLayout.Edge("public.users", "public.not_on_page")));
        assertEquals(3, pos.size());
    }
}
