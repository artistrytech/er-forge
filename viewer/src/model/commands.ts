/**
 * 編集コマンド（H-01〜H-08 / I-04 / I-06 / 詳細設計 §1.2）。
 *
 * すべての編集操作を「適用と反転ができる値」として表現する（INV-4）。
 * from / to（追加 / 除去は「除去前の値」）を持つため、反転は入れ替えるだけで済み、
 * Undo が1関数に収まる。整列（H-06）・自動レイアウト（H-07 / H-08）も
 * moveNodes 1個として記録するため、50ノードを動かしても Undo 1回で戻る。
 */
import type { Diagram, DiagramNode } from "./types";

export type Pos = [number, number];

export interface MoveChange {
  from: Pos;
  to: Pos;
}

/** H-01 / H-02 / H-06 / H-07 / H-08: 移動（整列・自動レイアウトも1コマンドにまとめる） */
export interface MoveCommand {
  type: "moveNodes";
  changes: Record<string, MoveChange>;
}
/** I-04: ページへの配置。トレイからのドラッグ・「このページに追加」・H-08 の自動配置 */
export interface AddCommand {
  type: "addNodes";
  nodes: Record<string, DiagramNode>;
}
/** I-06 / N-04: ページからの除去。除去前の値を持つため Undo で復元できる */
export interface RemoveCommand {
  type: "removeNodes";
  nodes: Record<string, DiagramNode>;
}

export type Command = MoveCommand | AddCommand | RemoveCommand;

/** 8px グリッドスナップ + 整数化（INV-2）。コマンドを作る時点で適用する */
export function snap(x: number, y: number): Pos {
  return [Math.round(x / 8) * 8, Math.round(y / 8) * 8];
}

export function invert(cmd: Command): Command {
  if (cmd.type === "moveNodes") {
    const changes: Record<string, MoveChange> = {};
    for (const [id, c] of Object.entries(cmd.changes)) {
      changes[id] = { from: c.to, to: c.from };
    }
    return { type: "moveNodes", changes };
  }
  // 追加 ⇄ 除去。除去コマンドが除去前の値を持つため、そのまま復元できる
  return { type: cmd.type === "addNodes" ? "removeNodes" : "addNodes", nodes: cmd.nodes };
}

function samePos(a: Pos, b: Pos): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * 移動コマンドを作る。正規化の結果すべて移動前と同一なら null
 * （8px 未満のドラッグは「操作なし」。クリックだけで dirty にしない。§3.2）。
 */
export function makeMove(moves: { id: string; from: Pos; to: Pos }[]): MoveCommand | null {
  const changes: Record<string, MoveChange> = {};
  for (const m of moves) {
    const to = snap(m.to[0], m.to[1]);
    if (!samePos(m.from, to)) {
      changes[m.id] = { from: m.from, to };
    }
  }
  return Object.keys(changes).length === 0 ? null : { type: "moveNodes", changes };
}

/** I-04: すでにページ上にあるテーブルは無視する（二重配置しない）。全部済みなら null */
export function makeAdd(
  diagram: Diagram,
  additions: { id: string; pos: Pos }[],
): AddCommand | null {
  const nodes: Record<string, DiagramNode> = {};
  for (const a of additions) {
    if (diagram.nodes?.[a.id] !== undefined) continue;
    nodes[a.id] = { pos: snap(a.pos[0], a.pos[1]) };
  }
  return Object.keys(nodes).length === 0 ? null : { type: "addNodes", nodes };
}

/** I-06 / N-04: 除去。Undo のため、除去前のノード（座標・幅）をコマンドに残す */
export function makeRemove(diagram: Diagram, tableIds: string[]): RemoveCommand | null {
  const nodes: Record<string, DiagramNode> = {};
  for (const id of tableIds) {
    const node = diagram.nodes?.[id];
    if (node !== undefined) nodes[id] = node;
  }
  return Object.keys(nodes).length === 0 ? null : { type: "removeNodes", nodes };
}

/** コマンドをダイアグラム（view / committed）へ適用した新しいオブジェクトを返す。 */
export function applyCommands(diagram: Diagram, commands: readonly Command[]): Diagram {
  if (commands.length === 0) return diagram;
  const nodes = { ...(diagram.nodes ?? {}) };
  for (const cmd of commands) {
    if (cmd.type === "moveNodes") {
      for (const [id, c] of Object.entries(cmd.changes)) {
        const node = nodes[id];
        if (node) nodes[id] = { ...node, pos: c.to };
      }
    } else if (cmd.type === "addNodes") {
      for (const [id, node] of Object.entries(cmd.nodes)) {
        nodes[id] = node;
      }
    } else {
      for (const id of Object.keys(cmd.nodes)) {
        delete nodes[id];
      }
    }
  }
  return { ...diagram, nodes };
}

/** PATCH のノードペイロード（null = このページから除去。サーバー側 DiagramService と対の形） */
export type NodePayload = Record<string, DiagramNode | null>;

/**
 * 送信ペイロードへの畳み込み（§4.2）。同一ノードへの複数コマンドは最終状態1つにする。
 * committed と同じ状態に戻っているノードは送らない（例: 動かして Undo で戻した、
 * 追加してから除去した）。差分を最小化し、無意味な Git 差分を出さないため。
 */
export function foldToPayload(commands: readonly Command[], committed: Diagram): NodePayload {
  // 各ノードの最終状態: DiagramNode = 存在する / null = 除去された
  const final = new Map<string, DiagramNode | null>();
  const base = committed.nodes ?? {};
  const currentOf = (id: string): DiagramNode | null | undefined =>
    final.has(id) ? final.get(id) : base[id];

  for (const cmd of commands) {
    if (cmd.type === "moveNodes") {
      for (const [id, c] of Object.entries(cmd.changes)) {
        const node = currentOf(id);
        // 除去済みのノードへの移動は起こらない（コマンドはページ状態に対して積まれる）
        if (node) final.set(id, { ...node, pos: c.to });
      }
    } else if (cmd.type === "addNodes") {
      for (const [id, node] of Object.entries(cmd.nodes)) {
        final.set(id, node);
      }
    } else {
      for (const id of Object.keys(cmd.nodes)) {
        final.set(id, null);
      }
    }
  }

  const payload: NodePayload = {};
  for (const [id, node] of final) {
    const committedNode = base[id];
    if (node === null) {
      // 元から無かったノードの除去（追加 → 除去）は送らない
      if (committedNode !== undefined) payload[id] = null;
    } else if (committedNode === undefined) {
      payload[id] = node;                            // 新規配置（I-04）
    } else if (!samePos(committedNode.pos, node.pos)) {
      payload[id] = { pos: node.pos };               // 移動。w など他のキーはサーバーが保持する
    }
  }
  return payload;
}
