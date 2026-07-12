/**
 * ER図キャンバス（C-01〜C-09 / E-01〜E-05 / D-01〜D-06）。
 * ノードとエッジは index.js + diagrams/<id>.js だけで描く（設計書 §6.1）。
 * Phase1 は閲覧専用（編集セッションはフェーズ3）。ノードは動かせない。
 *
 * nodes / edges の配列は選択状態に依存させない（選択で作り直すと React Flow が
 * 計測をやり直し、ダブルクリックが成立しなくなる。canvasStore.ts 参照）。
 */
import { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useViewport,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import { useI18n } from "../i18n/useI18n";
import { loadDiagram } from "../model/loader";
import { formatName, resolveTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import type { IndexTable, Relation } from "../model/types";
import { useCanvasStore } from "./canvasStore";
import { RelationEdge, type RelationEdgeType } from "./RelationEdge";
import { TableNode, type TableNodeType } from "./TableNode";

const nodeTypes: NodeTypes = { table: TableNode };
const edgeTypes: EdgeTypes = { relation: RelationEdge };

interface ErdPageProps {
  diagramId: string;
  focusTableId?: string;
}

export function ErdPage(props: ErdPageProps) {
  return (
    <ReactFlowProvider>
      <ErdCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ErdCanvas({ diagramId, focusTableId }: ErdPageProps) {
  const { t } = useI18n();
  const manifest = useAppStore((s) => s.manifest);
  const diagram = useAppStore((s) => s.diagrams[diagramId]);
  const diagramError = useAppStore((s) => s.diagramErrors[diagramId]);
  const index = useAppStore((s) => s.index);
  const tableErrors = useAppStore((s) => s.tableErrors);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const openDialog = useAppStore((s) => s.openDialog);
  const select = useCanvasStore((s) => s.select);
  const clearSelection = useCanvasStore((s) => s.clear);

  useEffect(() => {
    void loadDiagram(diagramId);
  }, [diagramId]);

  const indexTables = useMemo(() => {
    const map = new Map<string, IndexTable>();
    for (const it of index?.tables ?? []) map.set(it.id, it);
    return map;
  }, [index]);

  // このページに描画するリレーション = 両端のノードがページ上にあるもの
  const pageRelations = useMemo(() => {
    const nodes = diagram?.nodes ?? {};
    return (index?.relations ?? []).filter(
      (r) => nodes[r.from] !== undefined && nodes[r.to] !== undefined,
    );
  }, [diagram, index]);

  // ページ切替・フォーカス変更で選択を張り替える
  useEffect(() => {
    if (focusTableId !== undefined) {
      select({ type: "node", id: focusTableId }, pageRelations);
    } else {
      clearSelection();
    }
  }, [focusTableId, diagramId, pageRelations, select, clearSelection]);

  const builtNodes = useMemo<TableNodeType[]>(() => {
    if (!diagram) return [];
    return Object.entries(diagram.nodes ?? {}).map(([tableId, layout]) => {
      const it = indexTables.get(tableId);
      const missing = it === undefined || tableErrors[tableId] !== undefined;
      let primary = tableId;
      let secondary: string | undefined;
      let notes: string | undefined;
      if (it) {
        const resolved = resolveTableName(it.name, it.displayName);
        primary = formatName(resolved, it.name, nameDisplay === "both" ? "logical" : nameDisplay);
        if (nameDisplay === "both" && resolved.source !== "physical") secondary = it.name;
      }
      return {
        id: tableId,
        type: "table" as const,
        position: { x: layout.pos[0], y: layout.pos[1] },
        width: layout.w,
        data: { primary, secondary, missing, notes },
        draggable: false,
        connectable: false,
      };
    });
  }, [diagram, indexTables, tableErrors, nameDisplay]);

  // 計測結果（measured）を onNodesChange 経由でノードへ書き戻す。
  // これがないと MiniMap がノードを描けず、再レンダー時に再計測が走る
  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>([]);
  useEffect(() => {
    setNodes(builtNodes);
  }, [builtNodes, setNodes]);

  const edges = useMemo<RelationEdgeType[]>(() => {
    if (!diagram) return [];
    // 同一テーブルペア間の複数リレーションをずらして重なりを避ける
    const pairCount = new Map<string, number>();
    for (const r of pageRelations) {
      const key = [r.from, r.to].sort().join("→");
      pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    }
    const pairSeen = new Map<string, number>();
    return pageRelations.map((r: Relation) => {
      const key = [r.from, r.to].sort().join("→");
      const total = pairCount.get(key) ?? 1;
      const seen = pairSeen.get(key) ?? 0;
      pairSeen.set(key, seen + 1);
      // 法線はエッジの向きで反転するため、向きが逆のエッジ同士が同じ側に
      // ずれないよう、テーブルID の正準順で符号を固定する
      const dirSign = r.from <= r.to ? 1 : -1;
      const offset = total > 1 ? (seen - (total - 1) / 2) * 24 * dirSign : 0;
      return {
        id: r.id,
        type: "relation" as const,
        source: r.from,
        target: r.to,
        data: {
          relation: r,
          waypoints: diagram.edges?.[r.id]?.waypoints,
          offset,
        },
      };
    });
  }, [diagram, pageRelations]);

  const onNodeClick = useCallback(
    (_e: unknown, node: TableNodeType) => select({ type: "node", id: node.id }, pageRelations),
    [select, pageRelations],
  );
  const onEdgeClick = useCallback(
    (_e: unknown, edge: RelationEdgeType) => select({ type: "edge", id: edge.id }, pageRelations),
    [select, pageRelations],
  );
  const onNodeDoubleClick = useCallback(
    (_e: unknown, node: TableNodeType) => openDialog({ type: "table", id: node.id }),
    [openDialog],
  );
  const onEdgeDoubleClick = useCallback(
    (_e: unknown, edge: RelationEdgeType) => openDialog({ type: "relation", id: edge.id }),
    [openDialog],
  );

  const exists = manifest?.diagrams?.some((d) => d.id === diagramId) ?? false;
  if (!exists || diagramError !== undefined) {
    return (
      <div className="empty-state">
        <p>{t("canvas.notFound", { id: diagramId })}</p>
      </div>
    );
  }
  if (!diagram) {
    return <div className="empty-state">{t("canvas.loading")}</div>;
  }

  return (
    <div className="erd-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        onlyRenderVisibleElements
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => clearSelection()}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeDoubleClick={onEdgeDoubleClick}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
        <Panel position="top-left" className="erd-legend">
          <span className="erd-legend-item">
            <svg width="34" height="10" aria-hidden="true">
              <line x1="0" y1="5" x2="34" y2="5" className="erd-legend-solid" />
            </svg>
            {t("canvas.legend.physical")}
          </span>
          <span className="erd-legend-item">
            <svg width="34" height="10" aria-hidden="true">
              <line x1="0" y1="5" x2="34" y2="5" className="erd-legend-dashed" />
            </svg>
            {t("canvas.legend.logical")}
          </span>
        </Panel>
        <ZoomPanel />
        <FocusOnTable diagramId={diagramId} tableId={focusTableId} />
        <KeyboardShortcuts />
        {Object.keys(diagram.nodes ?? {}).length === 0 && (
          <Panel position="top-center">
            <div className="erd-empty-note">{t("canvas.empty")}</div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

/** ズーム率の表示と 100% / 全体表示（C-03 / C-04） */
function ZoomPanel() {
  const { t } = useI18n();
  const { zoom } = useViewport();
  const rf = useReactFlow();
  return (
    <Panel position="top-right" className="erd-zoom-panel">
      <span className="erd-zoom-value">{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => void rf.zoomTo(1, { duration: 200 })}>
        {t("canvas.zoomReset")}
      </button>
      <button type="button" onClick={() => void rf.fitView({ duration: 200 })}>
        {t("canvas.fit")}
      </button>
    </Panel>
  );
}

/** `#/erd/<id>/<tableId>` で該当ノードを中央表示する（B-04） */
function FocusOnTable({ diagramId, tableId }: { diagramId: string; tableId?: string }) {
  const rf = useReactFlow();
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized || tableId === undefined) return;
    const node = rf.getInternalNode(tableId);
    if (!node) return;
    const w = node.measured.width ?? 160;
    const h = node.measured.height ?? 40;
    void rf.setCenter(node.internals.positionAbsolute.x + w / 2, node.internals.positionAbsolute.y + h / 2, {
      zoom: Math.max(rf.getZoom(), 1),
      duration: 300,
    });
  }, [initialized, tableId, diagramId, rf]);
  return null;
}

/** N-02: Shift+1 = 全体フィット、Shift+0 = 100% */
function KeyboardShortcuts() {
  const rf = useReactFlow();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) {
        void rf.fitView({ duration: 200 });
      } else if (e.shiftKey && (e.key === "0" || e.code === "Digit0")) {
        void rf.zoomTo(1, { duration: 200 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf]);
  return null;
}
