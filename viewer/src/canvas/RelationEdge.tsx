/**
 * リレーションエッジ（E-01 / E-02 / E-03 / E-09）。
 * - ノードの中心を結ぶ線を矩形境界でクリップするフローティングエッジ
 * - 物理FK = 実線、論理外部制約 = 破線
 * - 端点に鳥の足記号（カーディナリティ）を描画する
 * - 自己参照はノード右側のループとして描画する
 * - waypoints があれば折れ線として経由する
 */
import { memo } from "react";
import { BaseEdge, useInternalNode, type Edge, type EdgeProps } from "@xyflow/react";
import type { CardEnd, Relation } from "../model/types";
import { useCanvasStore } from "./canvasStore";

export interface RelationEdgeData extends Record<string, unknown> {
  relation: Relation;
  waypoints?: [number, number][];
  /** 同一ペア間の複数エッジをずらすためのオフセット（px） */
  offset?: number;
}

export type RelationEdgeType = Edge<RelationEdgeData, "relation">;

interface Pt {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 矩形中心から外部点 p へ向かう線と矩形境界の交点 */
function borderPoint(rect: Rect, p: Pt): Pt {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

function angleDeg(from: Pt, to: Pt): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/**
 * 鳥の足記号（Phase0 詳細設計 §5.4）。
 * ローカル座標: 原点 = ノード境界上の端点、+x = エッジがノードから離れる向き。
 * ノードに近い側 = 最大多重度（鳥の足 or 縦棒）、遠い側 = 最小多重度（○ or 縦棒）。
 */
function CardMarker({ x, y, angle, card }: { x: number; y: number; angle: number; card: CardEnd | undefined }) {
  if (card === undefined) return null;
  const many = card.endsWith("N");
  const optional = card.startsWith("0");
  return (
    <g transform={`translate(${x}, ${y}) rotate(${angle})`} className="erd-card-marker">
      {many ? (
        <path d="M11 0 L1 -6 M11 0 L1 0 M11 0 L1 6" fill="none" />
      ) : (
        <line x1={9} y1={-6} x2={9} y2={6} />
      )}
      {optional ? (
        <circle cx={18} cy={0} r={4} className="erd-card-circle" />
      ) : (
        <line x1={16} y1={-6} x2={16} y2={6} />
      )}
    </g>
  );
}

function polylinePath(points: Pt[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

export const RelationEdge = memo(function RelationEdge({
  id,
  source,
  target,
  data,
}: EdgeProps<RelationEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const dimmed = useCanvasStore((s) => s.selection !== null && !s.relatedEdges.has(id));
  const highlighted = useCanvasStore(
    (s) => s.selection?.type === "edge" && s.selection.id === id,
  );
  if (!sourceNode || !targetNode || !data) return null;

  const rel = data.relation;
  const sRect: Rect = {
    x: sourceNode.internals.positionAbsolute.x,
    y: sourceNode.internals.positionAbsolute.y,
    w: sourceNode.measured.width ?? 160,
    h: sourceNode.measured.height ?? 40,
  };
  const tRect: Rect = {
    x: targetNode.internals.positionAbsolute.x,
    y: targetNode.internals.positionAbsolute.y,
    w: targetNode.measured.width ?? 160,
    h: targetNode.measured.height ?? 40,
  };

  let path: string;
  let sAnchor: Pt;
  let tAnchor: Pt;
  let sAngle: number;
  let tAngle: number;

  if (source === target) {
    // 自己参照（E-03）: ノード右側のループ
    const right = sRect.x + sRect.w;
    const cy = sRect.y + sRect.h / 2;
    sAnchor = { x: right, y: cy - 10 };
    tAnchor = { x: right, y: cy + 10 };
    const ext = 70 + (data.offset ?? 0);
    path = `M ${sAnchor.x} ${sAnchor.y} C ${right + ext} ${cy - 45}, ${right + ext} ${cy + 45}, ${tAnchor.x} ${tAnchor.y}`;
    sAngle = -35;
    tAngle = 35;
  } else {
    const sCenter: Pt = { x: sRect.x + sRect.w / 2, y: sRect.y + sRect.h / 2 };
    const tCenter: Pt = { x: tRect.x + tRect.w / 2, y: tRect.y + tRect.h / 2 };
    const waypoints: Pt[] = (data.waypoints ?? []).map(([x, y]) => ({ x, y }));

    const sToward = waypoints.length > 0 ? waypoints[0]! : tCenter;
    const tToward = waypoints.length > 0 ? waypoints[waypoints.length - 1]! : sCenter;

    sAnchor = borderPoint(sRect, sToward);
    tAnchor = borderPoint(tRect, tToward);

    // 同一ペア間の重複エッジをずらす（線に垂直な方向へ端点ごと平行移動）
    const off = data.offset ?? 0;
    if (off !== 0 && waypoints.length === 0) {
      const len = Math.hypot(tAnchor.x - sAnchor.x, tAnchor.y - sAnchor.y) || 1;
      const nx = (-(tAnchor.y - sAnchor.y) / len) * off;
      const ny = ((tAnchor.x - sAnchor.x) / len) * off;
      sAnchor = { x: sAnchor.x + nx, y: sAnchor.y + ny };
      tAnchor = { x: tAnchor.x + nx, y: tAnchor.y + ny };
    }
    path = polylinePath([sAnchor, ...waypoints, tAnchor]);
    sAngle = angleDeg(sAnchor, sToward);
    tAngle = angleDeg(tAnchor, tToward);
  }

  const cls =
    "erd-edge" +
    (rel.kind === "logical" ? " erd-edge-logical" : "") +
    (dimmed ? " erd-dimmed" : "") +
    (highlighted ? " erd-edge-highlighted" : "");

  return (
    <g className={cls}>
      <BaseEdge id={id} path={path} className="erd-edge-path" interactionWidth={14} />
      {/* from = 子（FK を持つ側）→ 子側の多重度、to = 親 → 親側の多重度（設計書 §5.5） */}
      <CardMarker x={sAnchor.x} y={sAnchor.y} angle={sAngle} card={rel.cardinality?.child} />
      <CardMarker x={tAnchor.x} y={tAnchor.y} angle={tAngle} card={rel.cardinality?.parent} />
    </g>
  );
});
