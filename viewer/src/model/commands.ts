/**
 * 編集コマンド（H-01〜H-08 / 詳細設計 §1.2）。
 *
 * すべての編集操作を「適用と反転ができる値」として表現する（INV-4）。
 * from / to を持つため、反転は入れ替えるだけで済む。Phase3 の編集操作は
 * レイアウト移動のみだが、型は将来の拡張（追加 / 除去 / 経由点）に開いておく。
 */
import type { Diagram } from "./types";

export type Pos = [number, number];

export interface MoveChange {
  from: Pos;
  to: Pos;
}

export type Command = { type: "moveNodes"; changes: Record<string, MoveChange> };

/** 8px グリッドスナップ + 整数化（INV-2）。コマンドを作る時点で適用する */
export function snap(x: number, y: number): Pos {
  return [Math.round(x / 8) * 8, Math.round(y / 8) * 8];
}

export function invert(cmd: Command): Command {
  const changes: Record<string, MoveChange> = {};
  for (const [id, c] of Object.entries(cmd.changes)) {
    changes[id] = { from: c.to, to: c.from };
  }
  return { type: "moveNodes", changes };
}

function samePos(a: Pos, b: Pos): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * 移動コマンドを作る。正規化の結果すべて移動前と同一なら null
 * （8px 未満のドラッグは「操作なし」。クリックだけで dirty にしない。§3.2）。
 */
export function makeMove(
  moves: { id: string; from: Pos; to: Pos }[],
): Command | null {
  const changes: Record<string, MoveChange> = {};
  for (const m of moves) {
    const to = snap(m.to[0], m.to[1]);
    if (!samePos(m.from, to)) {
      changes[m.id] = { from: m.from, to };
    }
  }
  return Object.keys(changes).length === 0 ? null : { type: "moveNodes", changes };
}

/** コマンドをダイアグラム（view / committed）へ適用した新しいオブジェクトを返す。 */
export function applyCommands(diagram: Diagram, commands: readonly Command[]): Diagram {
  if (commands.length === 0) return diagram;
  const nodes = { ...(diagram.nodes ?? {}) };
  for (const cmd of commands) {
    for (const [id, c] of Object.entries(cmd.changes)) {
      const node = nodes[id];
      if (node) nodes[id] = { ...node, pos: c.to };
    }
  }
  return { ...diagram, nodes };
}

/**
 * 送信ペイロードへの畳み込み（§4.2）。同一ノードへの複数コマンドは最終座標1つにする。
 * committed と同じ座標に戻っているノードは送らない（差分を最小化する）。
 */
export function foldToPayload(
  commands: readonly Command[],
  committed: Diagram,
): Record<string, { pos: Pos }> {
  const finalPos = new Map<string, Pos>();
  for (const cmd of commands) {
    for (const [id, c] of Object.entries(cmd.changes)) {
      finalPos.set(id, c.to);
    }
  }
  const payload: Record<string, { pos: Pos }> = {};
  for (const [id, pos] of finalPos) {
    const base = committed.nodes?.[id]?.pos;
    if (base === undefined || !samePos(base, pos)) {
      payload[id] = { pos };
    }
  }
  return payload;
}
