package erd.layout;

import org.eclipse.elk.alg.layered.options.LayeredMetaDataProvider;
import org.eclipse.elk.alg.layered.options.LayeredOptions;
import org.eclipse.elk.core.RecursiveGraphLayoutEngine;
import org.eclipse.elk.core.data.LayoutMetaDataService;
import org.eclipse.elk.core.options.CoreOptions;
import org.eclipse.elk.core.options.Direction;
import org.eclipse.elk.core.options.EdgeRouting;
import org.eclipse.elk.core.util.NullElkProgressMonitor;
import org.eclipse.elk.graph.ElkNode;
import org.eclipse.elk.graph.util.ElkGraphUtil;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Eclipse ELK による自動レイアウト（H-07 / H-08 / 設計書 §4.2）。
 *
 * <p>サーバーの責務は<b>座標の計算だけ</b>である。既存ノードとの衝突回避・オフセット
 * （H-08 の「既存を1つも動かさない」）はビューア側が行い、この API は書き込みもロックも伴わない。
 *
 * <p>出力は決定論的でなければならない（同じページを2回レイアウトして違う座標が出ると、
 * 差分ノイズの原因になる）。ELK 自体は入力順に対して決定論的なため、<b>ノード・エッジを
 * ID 昇順に整列してから</b>グラフを組み立てる（クライアントの列挙順に依存させない）。
 */
public final class AutoLayout {

    /** レイアウト対象のノード。w / h はビューアが実測した描画サイズ。 */
    public record Node(String id, double w, double h) {}

    /** レイアウト対象のエッジ（参照元 → 参照先）。ページ上のリレーション。 */
    public record Edge(String from, String to) {}

    private static final double NODE_SPACING = 64;
    private static final double LAYER_SPACING = 96;
    private static final double DEFAULT_W = 180;
    private static final double DEFAULT_H = 44;

    static {
        // elk-alg-layered のメタデータ登録。ServiceLoader 経由でも発見されるが、
        // fat JAR での取りこぼしを避けるため明示的に登録する
        LayoutMetaDataService.getInstance().registerLayoutMetaDataProviders(new LayeredMetaDataProvider());
    }

    /**
     * @return ノードID → 座標 [x, y]。原点は左上 (0, 0) 基準の相対座標であり、
     *         ページ上のどこへ置くかはビューアが決める（8px グリッドにスナップ済み）
     */
    public Map<String, int[]> layout(List<Node> nodes, List<Edge> edges) {
        Map<String, int[]> out = new LinkedHashMap<>();
        if (nodes.isEmpty()) return out;

        ElkNode graph = ElkGraphUtil.createGraph();
        graph.setProperty(CoreOptions.ALGORITHM, LayeredOptions.ALGORITHM_ID);
        graph.setProperty(CoreOptions.DIRECTION, Direction.RIGHT);
        graph.setProperty(CoreOptions.EDGE_ROUTING, EdgeRouting.ORTHOGONAL);
        graph.setProperty(LayeredOptions.SPACING_NODE_NODE, NODE_SPACING);
        graph.setProperty(LayeredOptions.SPACING_NODE_NODE_BETWEEN_LAYERS, LAYER_SPACING);

        Map<String, ElkNode> byId = new LinkedHashMap<>();
        for (Node n : nodes.stream().sorted(Comparator.comparing(Node::id)).toList()) {
            if (byId.containsKey(n.id())) continue;
            ElkNode elk = ElkGraphUtil.createNode(graph);
            elk.setIdentifier(n.id());
            elk.setDimensions(n.w() > 0 ? n.w() : DEFAULT_W, n.h() > 0 ? n.h() : DEFAULT_H);
            byId.put(n.id(), elk);
        }
        List<Edge> sortedEdges = edges.stream()
                .sorted(Comparator.comparing(Edge::from).thenComparing(Edge::to))
                .toList();
        for (Edge e : sortedEdges) {
            ElkNode from = byId.get(e.from());
            ElkNode to = byId.get(e.to());
            // 両端がページ上にあるエッジのみ。自己参照はレイアウトに寄与しないため落とす
            if (from == null || to == null || from == to) continue;
            ElkGraphUtil.createSimpleEdge(from, to);
        }

        new RecursiveGraphLayoutEngine().layout(graph, new NullElkProgressMonitor());

        for (Map.Entry<String, ElkNode> e : byId.entrySet()) {
            ElkNode n = e.getValue();
            out.put(e.getKey(), new int[] { snap(n.getX()), snap(n.getY()) });
        }
        return out;
    }

    /** 8px グリッドスナップ + 整数化（設計書 §5.11 / INV-2）。 */
    private static int snap(double v) {
        return (int) Math.round(v / 8.0) * 8;
    }
}
