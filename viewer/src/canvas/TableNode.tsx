/**
 * テーブルノード（D-01）。テーブル名のみを描画し、カラムは描かない。
 * スキーマ名も表示しない（単一スキーマ前提。設計書 §1.2）。
 * 選択・減光は canvasStore を購読して決める（node.data に入れない。canvasStore.ts 参照）。
 */
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { cx } from "../lib/cx";
import { colorAttr } from "../model/colors";
import { useCanvasStore } from "./canvasStore";
import styles from "./TableNode.module.scss";

export interface TableNodeData extends Record<string, unknown> {
  /** 表示名（論理名 / 物理名 / 併記は解決済みで渡す） */
  primary: string;
  /** 併記時の物理名（primary が論理名のとき） */
  secondary?: string;
  /** index に存在しない・スキーマファイル欠損（D-05） */
  missing?: boolean;
  /** meta.notes があるテーブル（D-04 簡易対応: ホバーで表示） */
  notes?: string;
  /** 指定色（P-13）。未知トークンは colorAttr が落とし、既定の外観になる */
  color?: string;
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
  const cls = cx(
    styles.erdNode,
    data.missing && styles.erdNodeMissing,
    data.ghost && styles.erdNodeGhost,
    // 減光はエッジ（RelationEdge）と共用のため global クラスのまま
    dimmed && "erd-dimmed",
    selected && !data.ghost && styles.erdNodeSelected,
  );
  return (
    <div
      className={cls}
      title={data.notes}
      data-testid="erd-node"
      // 欠損（警告色）・選択枠は指定色より上のレイヤ。CSS の後勝ちで担保する（D-03）
      data-color={colorAttr(data.color)}
      data-ghost={data.ghost === true ? "true" : undefined}
    >
      <Handle type="target" position={Position.Top} className={styles.erdHandle} isConnectable={false} />
      <div className={styles.erdNodeName}>{data.primary}</div>
      {data.secondary !== undefined && <div className={styles.erdNodeSub}>{data.secondary}</div>}
      {data.missing && <div className={styles.erdNodeWarn}>⚠</div>}
      <Handle type="source" position={Position.Bottom} className={styles.erdHandle} isConnectable={false} />
    </div>
  );
});
