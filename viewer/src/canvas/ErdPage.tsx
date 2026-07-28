/**
 * ER図キャンバス（C-01〜C-09 / E-01〜E-05 / D-01〜D-06）。
 * ノードとエッジは index.js + diagrams/<id>.js だけで描く（設計書 §6.1）。
 * 編集セッション中は配置（H-01 移動 / I-04 追加 / I-06 除去 / H-07・H-08 自動レイアウト）を扱う。
 *
 * nodes / edges の配列は選択状態に依存させない（選択で作り直すと React Flow が
 * 計測をやり直し、ダブルクリックが成立しなくなる。canvasStore.ts 参照）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { makeAdd, makeMove, makeRemove, snap, type Pos } from "../model/commands";
import { requestAutoLayout, useEditStore } from "../model/editStore";
import { loadDiagram } from "../model/loader";
import { formatName, resolveTableName } from "../model/logicalName";
import { tokenColor } from "../model/colors";
import { useAppStore } from "../model/store";
import type { IndexTable, Relation } from "../model/types";
import { Dialog } from "../ui/Dialog";
import { useCanvasStore } from "./canvasStore";
import { RelationEdge, type RelationEdgeType } from "./RelationEdge";
import { TableNode, type TableNodeType } from "./TableNode";
import styles from "./ErdPage.module.scss";

const nodeTypes: NodeTypes = { table: TableNode };
const edgeTypes: EdgeTypes = { relation: RelationEdge };

/** 自動レイアウトのプレビューで「現在の配置」を薄く重ねるノードのID接頭辞（H-07 §7.2） */
const GHOST = "ghost:";
/** H-08: 既存ノードのバウンディングボックスから、新規ノードを離す距離 */
const PLACE_GAP = 120;
/** ドラッグ&ドロップの MIME（トレイ → キャンバス。I-04） */
export const TABLE_DND_TYPE = "application/x-erd-table";

const isGhost = (id: string): boolean => id.startsWith(GHOST);

/** MiniMap のノード色（D-03）。指定色が無いテーブルは MiniMap の既定色に任せる */
function miniMapNodeColor(node: { data?: { color?: unknown } }): string {
  const color = typeof node.data?.color === "string" ? node.data.color : undefined;
  return tokenColor(color, "border") ?? "#e2e4e8";
}

/** 未配置テーブルはまだ描画されておらず実測サイズが無い。ラベル長から見積もる */
function estimateSize(label: string): { w: number; h: number } {
  return { w: Math.min(320, Math.max(140, label.length * 9 + 48)), h: 44 };
}

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
  const rf = useReactFlow();
  const manifest = useAppStore((s) => s.manifest);
  const diagram = useAppStore((s) => s.diagrams[diagramId]);
  const diagramError = useAppStore((s) => s.diagramErrors[diagramId]);
  const index = useAppStore((s) => s.index);
  const tableErrors = useAppStore((s) => s.tableErrors);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const openDialog = useAppStore((s) => s.openDialog);
  const addToast = useAppStore((s) => s.addToast);
  const serverMode = useAppStore((s) => s.serverMode === true);
  const select = useCanvasStore((s) => s.select);
  const clearSelection = useCanvasStore((s) => s.clear);
  const setPlaceTables = useCanvasStore((s) => s.setPlaceTables);
  const editing = useEditStore((s) => s.session === "editing");
  const pushCommand = useEditStore((s) => s.push);
  const setDragging = useEditStore((s) => s.setDragging);
  const setCurrentDiagramId = useAppStore((s) => s.setCurrentDiagramId);

  /** H-07 のプレビュー中の提案座標（null = プレビューしていない）。確定するまで書き込まない */
  const [preview, setPreview] = useState<Record<string, Pos> | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState<string[] | null>(null);
  /** 配置編集ができるのは「サーバーモード × 編集中」だけ（§9.6） */
  const canPlace = editing && serverMode;

  useEffect(() => {
    void loadDiagram(diagramId);
  }, [diagramId]);

  // SSE の外部変更分岐（H-09）が「現在のページか」を判定できるようにする
  useEffect(() => {
    setCurrentDiagramId(diagramId);
    return () => setCurrentDiagramId(null);
  }, [diagramId, setCurrentDiagramId]);

  // 未保存があっても他ルートへの遷移・リロードは妨げない（確認は「編集を終了」操作に限定。
  // ヘッダの EditControls が担う）。以前あったハッシュ遷移ガードは撤廃した。

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
        // kind は通常テーブルのとき索引に載らない。載っていればそのままバッジになる（D-07）
        data: { primary, secondary, missing, notes, color: it?.color, kind: it?.kind },
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

  // H-01 / H-02: ドラッグ確定（手を離したとき）が1操作 = コマンド1つ（§3.1）
  const onNodeDragStart = useCallback(() => setDragging(true), [setDragging]);
  const onNodeDragStop = useCallback(
    (_e: unknown, _node: TableNodeType, dragged: TableNodeType[]) => {
      setDragging(false);
      const current = useAppStore.getState().diagrams[diagramId];
      if (!current) return;
      const moves = dragged.flatMap((n) => {
        const from = current.nodes?.[n.id]?.pos;
        if (from === undefined) return [];
        return [{ id: n.id, from, to: [n.position.x, n.position.y] as [number, number] }];
      });
      const cmd = makeMove(moves);
      if (cmd) pushCommand(diagramId, cmd);
    },
    [diagramId, pushCommand, setDragging],
  );

  // ---------------------------------------------- I-04: テーブルのページ追加（トレイ / ドロップ）

  const labelOf = useCallback(
    (tableId: string): string => {
      const it = indexTables.get(tableId);
      if (!it) return tableId;
      return formatName(resolveTableName(it.name, it.displayName), it.name, nameDisplay);
    },
    [indexTables, nameDisplay],
  );

  /**
   * H-08: 未配置テーブルのみを ELK で配置する。**既存ノードの座標は1つも変えない**
   * （配置の質より「既存を動かさない」ことを優先する。詳細設計 §7.3）。
   * 既存のバウンディングボックスの右側へ丸ごとオフセットするため、衝突は起こりえない。
   */
  const autoPlacePositions = useCallback(
    async (ids: string[]): Promise<Record<string, Pos> | null> => {
      const relations = (index?.relations ?? []).filter(
        (r) => ids.includes(r.from) && ids.includes(r.to),
      );
      const raw = await requestAutoLayout(
        ids.map((id) => ({ id, ...estimateSize(labelOf(id)) })),
        relations.map((r) => ({ from: r.from, to: r.to })),
      );
      if (raw === null) return null;

      const existing = rf.getNodes().filter((n) => !isGhost(n.id));
      let ox = 0;
      let oy = 0;
      if (existing.length > 0) {
        const right = Math.max(
          ...existing.map((n) => n.position.x + (n.measured?.width ?? 180)),
        );
        const top = Math.min(...existing.map((n) => n.position.y));
        [ox, oy] = snap(right + PLACE_GAP, top);
      }
      const out: Record<string, Pos> = {};
      for (const [id, p] of Object.entries(raw)) {
        out[id] = snap(p[0] + ox, p[1] + oy);
      }
      return out;
    },
    [index, labelOf, rf],
  );

  const placeTables = useCallback(
    (tableIds: string[], at?: Pos) => {
      void (async () => {
        const current = useAppStore.getState().diagrams[diagramId];
        if (!current) return;
        const toAdd = tableIds.filter((id) => current.nodes?.[id] === undefined);
        if (toAdd.length === 0) return;

        let positions: Record<string, Pos> | null;
        if (at !== undefined) {
          // ドロップ位置に置く（複数まとめてドロップした場合はずらす）
          positions = {};
          toAdd.forEach((id, i) => {
            positions![id] = snap(at[0] + (i % 3) * 240, at[1] + Math.floor(i / 3) * 96);
          });
        } else {
          setLayoutBusy(true);
          positions = await autoPlacePositions(toAdd);
          setLayoutBusy(false);
          if (positions === null) {
            addToast(t("layout.failed"));
            return;
          }
        }
        const cmd = makeAdd(
          current,
          toAdd.map((id) => ({ id, pos: positions[id] ?? [0, 0] })),
        );
        if (!cmd) return;
        pushCommand(diagramId, cmd);
        addToast(t("tray.added", { n: Object.keys(cmd.nodes).length }));
        // 配置後は新規ノードが見えるようスクロールする（K-12 §7.3）
        setTimeout(() => {
          void rf.fitView({ nodes: toAdd.map((id) => ({ id })), duration: 400, maxZoom: 1 });
        }, 60);
      })();
    },
    [addToast, autoPlacePositions, diagramId, pushCommand, rf, t],
  );

  // トレイ（キャンバス外）からの配置を受け付ける。閲覧中・静的モードでは登録しない
  useEffect(() => {
    setPlaceTables(canPlace ? placeTables : null);
    return () => setPlaceTables(null);
  }, [canPlace, placeTables, setPlaceTables]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!canPlace) return;
      const raw = e.dataTransfer.getData(TABLE_DND_TYPE);
      if (raw === "") return;
      e.preventDefault();
      const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      placeTables(raw.split(","), [at.x, at.y]);
    },
    [canPlace, placeTables, rf],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!canPlace) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [canPlace],
  );

  // ------------------------------------------------------- I-06 / N-04: ページからの除去

  const requestRemove = useCallback(() => {
    const ids = rf.getNodes().filter((n) => n.selected && !isGhost(n.id)).map((n) => n.id);
    if (ids.length > 0) setRemoveConfirm(ids);
  }, [rf]);

  const confirmRemove = useCallback(() => {
    const ids = removeConfirm ?? [];
    setRemoveConfirm(null);
    const current = useAppStore.getState().diagrams[diagramId];
    if (!current) return;
    // 除去前の値をコマンドに残すため、Undo で座標ごと復元できる（H-05）
    const cmd = makeRemove(current, ids);
    if (!cmd) return;
    pushCommand(diagramId, cmd);
    clearSelection();
    addToast(t("node.removed", { n: Object.keys(cmd.nodes).length }));
  }, [addToast, clearSelection, diagramId, pushCommand, removeConfirm, t]);

  // -------------------------------------------------- H-07: 自動レイアウト（ページ全体）

  /**
   * ページ全体の再配置は破壊的である（手で整えた配置が全部飛ぶ）。プレビューなしに適用しない。
   * 提案配置を実線で、現在の配置をゴーストとして薄く重ねる（詳細設計 §7.2）。
   */
  const startLayoutPreview = useCallback(() => {
    void (async () => {
      const nodes = rf.getNodes().filter((n) => !isGhost(n.id));
      if (nodes.length === 0) {
        addToast(t("layout.empty"));
        return;
      }
      setLayoutBusy(true);
      const raw = await requestAutoLayout(
        nodes.map((n) => ({
          id: n.id,
          w: n.measured?.width ?? 180,
          h: n.measured?.height ?? 44,
        })),
        pageRelations.map((r) => ({ from: r.from, to: r.to })),
      );
      setLayoutBusy(false);
      if (raw === null) {
        addToast(t("layout.failed"));
        return;
      }
      // ELK の座標は原点基準。現在の左上に合わせ、図が遠くへ飛ばないようにする
      const [ox, oy] = snap(
        Math.min(...nodes.map((n) => n.position.x)),
        Math.min(...nodes.map((n) => n.position.y)),
      );
      const proposed: Record<string, Pos> = {};
      for (const [id, p] of Object.entries(raw)) {
        proposed[id] = snap(p[0] + ox, p[1] + oy);
      }
      setPreview(proposed);
      setNodes((ns) => {
        const real = ns.filter((n) => !isGhost(n.id));
        const ghosts: TableNodeType[] = real.map((n) => ({
          ...n,
          id: GHOST + n.id,
          data: { ...n.data, ghost: true },
          selected: false,
          draggable: false,
          selectable: false,
          zIndex: 0,
        }));
        const moved = real.map((n) => {
          const p = proposed[n.id];
          return p === undefined ? n : { ...n, position: { x: p[0], y: p[1] } };
        });
        return [...ghosts, ...moved];
      });
    })();
  }, [addToast, pageRelations, rf, setNodes, t]);

  const applyLayoutPreview = useCallback(() => {
    const proposed = preview;
    setPreview(null);
    setNodes(builtNodes); // ゴーストを畳む。コマンドの結果は builtNodes 経由で戻ってくる
    const current = useAppStore.getState().diagrams[diagramId];
    if (!proposed || !current) return;
    // 50ノードを動かしても moveNodes コマンド1個 = Undo 1回で完全に戻る（T-17）
    const cmd = makeMove(
      Object.entries(proposed).flatMap(([id, to]) => {
        const from = current.nodes?.[id]?.pos;
        return from === undefined ? [] : [{ id, from, to }];
      }),
    );
    if (cmd) pushCommand(diagramId, cmd);
  }, [builtNodes, diagramId, preview, pushCommand, setNodes]);

  const cancelLayoutPreview = useCallback(() => {
    setPreview(null);
    setNodes(builtNodes);
  }, [builtNodes, setNodes]);

  // プレビュー中にページを離れる・編集を終える場合は破棄する（未確定の座標を残さない）
  useEffect(() => {
    if (!editing && preview !== null) {
      setPreview(null);
      setNodes(builtNodes);
    }
  }, [builtNodes, editing, preview, setNodes]);

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

  const previewing = preview !== null;

  return (
    <div className={styles.erdCanvas} onDrop={onDrop} onDragOver={onDragOver}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2.5}
        nodesDraggable={editing && !previewing}
        nodesConnectable={false}
        elementsSelectable={editing && !previewing}
        snapToGrid
        snapGrid={[8, 8]}
        zoomOnDoubleClick={false}
        onlyRenderVisibleElements
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => clearSelection()}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeDoubleClick={onEdgeDoubleClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} />
        <Controls showInteractive={false} />
        {/* MiniMap も同じ指定色で塗る（全体像と本体で色が食い違わないように。D-03） */}
        <MiniMap pannable zoomable nodeColor={miniMapNodeColor} />
        <Panel position="top-left" className={styles.erdLegend} data-testid="erd-legend">
          <span className={styles.erdLegendItem}>
            <svg width="34" height="10" aria-hidden="true">
              <line x1="0" y1="5" x2="34" y2="5" className={styles.erdLegendSolid} />
            </svg>
            {t("canvas.legend.physical")}
          </span>
          <span className={styles.erdLegendItem}>
            <svg width="34" height="10" aria-hidden="true">
              <line x1="0" y1="5" x2="34" y2="5" className={styles.erdLegendDashed} />
            </svg>
            {t("canvas.legend.logical")}
          </span>
        </Panel>
        <ZoomPanel />
        {editing && !previewing && (
          <EditToolbar
            diagramId={diagramId}
            canPlace={canPlace}
            busy={layoutBusy}
            onAutoLayout={startLayoutPreview}
            onRemove={requestRemove}
          />
        )}
        {previewing && (
          <Panel position="top-center" className={styles.erdLayoutPreview} data-testid="erd-layout-preview">
            <span>{t("layout.previewing")}</span>
            <button type="button" className="header-button-primary" onClick={applyLayoutPreview}>
              {t("layout.apply")}
            </button>
            <button type="button" onClick={cancelLayoutPreview}>
              {t("layout.cancel")}
            </button>
          </Panel>
        )}
        <FocusOnTable diagramId={diagramId} tableId={focusTableId} />
        <KeyboardShortcuts
          diagramId={diagramId}
          canRemove={canPlace && !previewing}
          onRemove={requestRemove}
        />
        {Object.keys(diagram.nodes ?? {}).length === 0 && !previewing && (
          <Panel position="bottom-center">
            <div className={styles.erdEmptyNote}>{t("canvas.empty")}</div>
          </Panel>
        )}
      </ReactFlow>
      {removeConfirm !== null && (
        <ConfirmRemoveDialog
          count={removeConfirm.length}
          onCancel={() => setRemoveConfirm(null)}
          onConfirm={confirmRemove}
        />
      )}
    </div>
  );
}

/** I-06 / N-04: 除去は配置だけを消す（テーブル定義は残る）。Undo で戻せる */
function ConfirmRemoveDialog({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog title={t("node.removeConfirmTitle")} onClose={onCancel}>
      <p>{t("node.removeConfirmBody", { n: count })}</p>
      <div className="dialog-actions">
        <button type="button" className="header-button-primary" data-testid="remove-confirm" onClick={onConfirm}>
          {t("node.remove")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("layout.cancel")}
        </button>
      </div>
    </Dialog>
  );
}

/** ズーム率の表示と 100% / 全体表示（C-03 / C-04） */
function ZoomPanel() {
  const { t } = useI18n();
  const { zoom } = useViewport();
  const rf = useReactFlow();
  return (
    <Panel position="top-right" className={styles.erdZoomPanel}>
      <span className={styles.erdZoomValue}>{Math.round(zoom * 100)}%</span>
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

/** Undo / Redo・自動レイアウト・除去（H-05 / H-07 / I-06。閲覧中は表示しない） */
function EditToolbar({
  diagramId,
  canPlace,
  busy,
  onAutoLayout,
  onRemove,
}: {
  diagramId: string;
  canPlace: boolean;
  busy: boolean;
  onAutoLayout: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const page = useEditStore((s) => s.pages[diagramId]);
  const undo = useEditStore((s) => s.undo);
  const redo = useEditStore((s) => s.redo);
  return (
    <Panel position="top-center" className={styles.erdEditToolbar} data-testid="erd-edit-toolbar">
      <button
        type="button"
        disabled={(page?.undo.length ?? 0) === 0}
        onClick={() => undo(diagramId)}
        title="Ctrl+Z"
      >
        ↩ {t("edit.undo")}
      </button>
      <button
        type="button"
        disabled={(page?.redo.length ?? 0) === 0}
        onClick={() => redo(diagramId)}
        title="Ctrl+Shift+Z"
      >
        ↪ {t("edit.redo")}
      </button>
      <button
        type="button"
        data-testid="auto-layout"
        disabled={!canPlace || busy}
        onClick={onAutoLayout}
        // 静的モードでは ELK（サーバー API）が使えない。理由を明示する（詳細設計 §8.1）
        title={canPlace ? t("layout.auto") : t("layout.staticDisabled")}
      >
        ⇉ {busy ? t("layout.computing") : t("layout.auto")}
      </button>
      <button type="button" data-testid="remove-node" disabled={!canPlace} onClick={onRemove} title="Delete">
        🗑 {t("node.remove")}
      </button>
    </Panel>
  );
}

/** N-02: Shift+1 / Shift+0、N-03: Ctrl+Z / Ctrl+Shift+Z、N-04: Delete、N-10: Ctrl+S */
function KeyboardShortcuts({
  diagramId,
  canRemove,
  onRemove,
}: {
  diagramId: string;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const rf = useReactFlow();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const st = useEditStore.getState();
      if (e.key === "Delete" && canRemove && st.session === "editing") {
        e.preventDefault();
        onRemove();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (st.session !== "editing") return;
        e.preventDefault();
        if (e.shiftKey) {
          st.redo(diagramId);
        } else {
          st.undo(diagramId);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        // 保存はすべて明示（自動保存は無い。N-10）
        e.preventDefault();
        if (st.session === "editing" && useAppStore.getState().serverMode === true) {
          st.save();
        }
      } else if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) {
        void rf.fitView({ duration: 200 });
      } else if (e.shiftKey && (e.key === "0" || e.code === "Digit0")) {
        void rf.zoomTo(1, { duration: 200 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf, diagramId, canRemove, onRemove]);
  return null;
}
