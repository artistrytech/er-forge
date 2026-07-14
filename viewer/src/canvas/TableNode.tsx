/**
 * テーブルノード（D-01）。テーブル名のみを描画し、カラムは描かない。
 * スキーマ名も表示しない（単一スキーマ前提。設計書 §1.2）。
 * 選択・減光は canvasStore を購読して決める（node.data に入れない。canvasStore.ts 参照）。
 */
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useCanvasStore } from "./canvasStore";

export interface TableNodeData extends Record<string, unknown> {
  /** 表示名（論理名 / 物理名 / 併記は解決済みで渡す） */
  primary: string;
  /** 併記時の物理名（primary が論理名のとき） */
  secondary?: string;
  /** index に存在しない・スキーマファイル欠損（D-05） */
  missing?: boolean;
  /** meta.notes があるテーブル（D-04 簡易対応: ホバーで表示） */
  notes?: string;
  /** 自動レイアウトのプレビュー中に「現在の配置」を薄く重ねるゴースト（H-07 §7.2） */
  ghost?: boolean;
}

export type TableNodeType = Node<TableNodeData, "table">;

export const TableNode = memo(function TableNode({ id, data }: NodeProps<TableNodeType>) {
  const selected = useCanvasStore(
    (s) => s.selection?.type === "node" && s.selection.id === id,
  );
  const dimmed = useCanvasStore(
    (s) => !data.ghost && s.selection !== null && !s.relatedNodes.has(id),
  );
  const cls =
    "erd-node" +
    (data.missing ? " erd-node-missing" : "") +
    (data.ghost ? " erd-node-ghost" : "") +
    (dimmed ? " erd-dimmed" : "") +
    (selected && !data.ghost ? " erd-node-selected" : "");
  return (
    <div className={cls} title={data.notes}>
      <Handle type="target" position={Position.Top} className="erd-handle" isConnectable={false} />
      <div className="erd-node-name">{data.primary}</div>
      {data.secondary !== undefined && <div className="erd-node-sub">{data.secondary}</div>}
      {data.missing && <div className="erd-node-warn">⚠</div>}
      <Handle type="source" position={Position.Bottom} className="erd-handle" isConnectable={false} />
    </div>
  );
});
