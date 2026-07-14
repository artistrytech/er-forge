/**
 * 編集コマンドモデル（H-01〜H-05 / 詳細設計 §1.2・§3.2・§4.2）。
 * - T-1: 8px 未満のドラッグはコマンドにならない
 * - T-3: 複数ノードの一括移動は1コマンド（Undo 1回で戻る）
 * - 送信時の畳み込み: 同一ノードへの複数コマンドは最終座標1つ。
 *   committed に戻っているノードは送らない（動かして Undo した場合など）
 */
import { describe, expect, it } from "vitest";
import {
  applyCommands,
  foldToPayload,
  invert,
  makeAdd,
  makeMove,
  makeRemove,
  snap,
} from "../src/model/commands";
import type { Diagram } from "../src/model/types";

const diagram: Diagram = {
  id: "core",
  nodes: {
    "public.users": { pos: [120, 80] },
    "public.orders": { pos: [520, 80] },
  },
  edges: {},
};

describe("snap（INV-2）", () => {
  it("8px グリッドへ丸める", () => {
    expect(snap(203.7, 197)).toEqual([200, 200]);
    expect(snap(0, 0)).toEqual([0, 0]);
    expect(snap(-13, 5)).toEqual([-16, 8]);
  });
});

describe("makeMove", () => {
  it("T-1: 正規化後に同一座標なら null（クリックだけで dirty にしない）", () => {
    expect(makeMove([{ id: "public.users", from: [120, 80], to: [122, 81] }])).toBeNull();
  });

  it("T-3: 複数ノードの移動は1コマンドに入る", () => {
    const cmd = makeMove([
      { id: "public.users", from: [120, 80], to: [200, 80] },
      { id: "public.orders", from: [520, 80], to: [600, 80] },
    ]);
    expect(cmd).not.toBeNull();
    expect(Object.keys(cmd!.changes)).toHaveLength(2);
  });

  it("動いたノードだけが含まれる", () => {
    const cmd = makeMove([
      { id: "public.users", from: [120, 80], to: [200, 80] },
      { id: "public.orders", from: [520, 80], to: [521, 80] }, // 8px 未満
    ]);
    expect(Object.keys(cmd!.changes)).toEqual(["public.users"]);
  });
});

describe("invert / applyCommands", () => {
  it("apply → apply(invert) で元に戻る（Undo は逆コマンド。§5.2）", () => {
    const cmd = makeMove([{ id: "public.users", from: [120, 80], to: [200, 160] }])!;
    const moved = applyCommands(diagram, [cmd]);
    expect(moved.nodes!["public.users"]!.pos).toEqual([200, 160]);
    const reverted = applyCommands(moved, [invert(cmd)]);
    expect(reverted.nodes!["public.users"]!.pos).toEqual([120, 80]);
    // 触っていないノードは不変
    expect(reverted.nodes!["public.orders"]!.pos).toEqual([520, 80]);
  });

  it("w など他のキーを保持する", () => {
    const d: Diagram = { id: "x", nodes: { a: { pos: [0, 0], w: 260 } }, edges: {} };
    const cmd = makeMove([{ id: "a", from: [0, 0], to: [80, 0] }])!;
    expect(applyCommands(d, [cmd]).nodes!["a"]).toEqual({ pos: [80, 0], w: 260 });
  });
});

describe("foldToPayload（§4.2 / T-4 / T-13）", () => {
  it("同一ノードへの複数コマンドは最終座標1つに畳む", () => {
    const c1 = makeMove([{ id: "public.users", from: [120, 80], to: [200, 80] }])!;
    const c2 = makeMove([{ id: "public.users", from: [200, 80], to: [280, 80] }])!;
    const payload = foldToPayload([c1, c2], diagram);
    expect(payload).toEqual({ "public.users": { pos: [280, 80] } });
  });

  it("committed と同じ座標に戻ったノードは送らない（動かして Undo）", () => {
    const c1 = makeMove([{ id: "public.users", from: [120, 80], to: [200, 80] }])!;
    const payload = foldToPayload([c1, invert(c1)], diagram);
    expect(payload).toEqual({});
  });
});

describe("makeAdd / makeRemove（I-04 / I-06）", () => {
  it("すでにページ上にあるテーブルは追加しない（二重配置しない）", () => {
    expect(makeAdd(diagram, [{ id: "public.users", pos: [0, 0] }])).toBeNull();
    const cmd = makeAdd(diagram, [
      { id: "public.users", pos: [0, 0] },
      { id: "public.items", pos: [203.7, 197] },
    ])!;
    // 追加時も 8px スナップ（INV-2。ドロップ位置は端数を持つ）
    expect(cmd.nodes).toEqual({ "public.items": { pos: [200, 200] } });
  });

  it("除去コマンドは除去前の値を持つ（Undo で座標ごと復元できる）", () => {
    const d: Diagram = { id: "core", nodes: { a: { pos: [8, 8], w: 260 } }, edges: {} };
    const cmd = makeRemove(d, ["a", "not-on-page"])!;
    expect(cmd.nodes).toEqual({ a: { pos: [8, 8], w: 260 } });

    const removed = applyCommands(d, [cmd]);
    expect(removed.nodes).toEqual({});
    // 反転（= 追加）で幅まで含めて元に戻る
    expect(applyCommands(removed, [invert(cmd)]).nodes).toEqual({ a: { pos: [8, 8], w: 260 } });
  });

  it("ページ上に無いノードだけを指定したら null（dirty にしない）", () => {
    expect(makeRemove(diagram, ["public.nope"])).toBeNull();
  });
});

describe("foldToPayload: 追加と除去（I-04 / I-06）", () => {
  it("新規ノードは全体を、既存ノードの移動は pos だけを送る", () => {
    const add = makeAdd(diagram, [{ id: "public.items", pos: [40, 40] }])!;
    const move = makeMove([{ id: "public.users", from: [120, 80], to: [200, 80] }])!;
    expect(foldToPayload([add, move], diagram)).toEqual({
      "public.items": { pos: [40, 40] },
      "public.users": { pos: [200, 80] },
    });
  });

  it("除去は null として送る（サーバー側はこれをページからの除去として扱う）", () => {
    const cmd = makeRemove(diagram, ["public.orders"])!;
    expect(foldToPayload([cmd], diagram)).toEqual({ "public.orders": null });
  });

  it("追加してから除去したノードは送らない（committed には元から無い）", () => {
    const add = makeAdd(diagram, [{ id: "public.items", pos: [40, 40] }])!;
    const view = applyCommands(diagram, [add]);
    const remove = makeRemove(view, ["public.items"])!;
    expect(foldToPayload([add, remove], diagram)).toEqual({});
  });

  it("除去してから Undo で戻したノードは送らない（正味の変更なし）", () => {
    const remove = makeRemove(diagram, ["public.orders"])!;
    expect(foldToPayload([remove, invert(remove)], diagram)).toEqual({});
  });

  it("配置直後に動かしたノードは、最終座標つきの新規ノードとして1回だけ送る", () => {
    const add = makeAdd(diagram, [{ id: "public.items", pos: [40, 40] }])!;
    const move = makeMove([{ id: "public.items", from: [40, 40], to: [120, 40] }])!;
    expect(foldToPayload([add, move], diagram)).toEqual({
      "public.items": { pos: [120, 40] },
    });
  });
});
