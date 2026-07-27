/** 固定行高のウィンドウイング（カラム辞書 P-03 の一覧）。 */
import { describe, expect, it } from "vitest";
import { renderPlan, visibleRange } from "../src/lib/virtualRows";

const H = 44;

describe("visibleRange", () => {
  it("先頭では 0 から始まり、ビューポート分 + オーバースキャンを描く", () => {
    // 440px = 10行 → 10 + 1（半端な行）+ 8（下方向のオーバースキャン）
    expect(visibleRange(0, 440, 1000, H, 8)).toEqual({ start: 0, end: 19 });
  });

  it("スクロールすると窓が動く（上方向にもオーバースキャン）", () => {
    // scrollTop 4400 = 100行目
    expect(visibleRange(4400, 440, 1000, H, 8)).toEqual({ start: 92, end: 119 });
  });

  it("末尾では行数でクランプされる", () => {
    const r = visibleRange(1000 * H, 440, 1000, H, 8);
    expect(r.end).toBe(1000);
    expect(r.start).toBeLessThan(1000);
  });

  it("行が無い / 高さが未測定のうちは何も描かない", () => {
    expect(visibleRange(0, 440, 0, H, 8)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(0, 0, 100, H, 8)).toEqual({ start: 0, end: 0 });
  });
});

describe("renderPlan", () => {
  it("範囲の前後をスペーサーで埋める", () => {
    expect(renderPlan({ start: 2, end: 4 }, 10)).toEqual([
      { kind: "spacer", rows: 2 },
      { kind: "row", index: 2 },
      { kind: "row", index: 3 },
      { kind: "spacer", rows: 6 },
    ]);
  });

  it("先頭・末尾に接しているときは余分なスペーサーを出さない", () => {
    expect(renderPlan({ start: 0, end: 2 }, 2)).toEqual([
      { kind: "row", index: 0 },
      { kind: "row", index: 1 },
    ]);
  });

  // 入力中の行が消えると、打鍵と IME 変換が失われる（仮想化で最も痛い事故）
  it("pinned が範囲より前なら、正しい位置に差し込んでスペーサーを分割する", () => {
    expect(renderPlan({ start: 5, end: 7 }, 10, 1)).toEqual([
      { kind: "spacer", rows: 1 },
      { kind: "row", index: 1 },
      { kind: "spacer", rows: 3 },
      { kind: "row", index: 5 },
      { kind: "row", index: 6 },
      { kind: "spacer", rows: 3 },
    ]);
  });

  it("pinned が範囲より後でも同じ", () => {
    expect(renderPlan({ start: 0, end: 2 }, 10, 8)).toEqual([
      { kind: "row", index: 0 },
      { kind: "row", index: 1 },
      { kind: "spacer", rows: 6 },
      { kind: "row", index: 8 },
      { kind: "spacer", rows: 1 },
    ]);
  });

  it("pinned が範囲内なら二重に描かない", () => {
    expect(renderPlan({ start: 0, end: 2 }, 2, 1)).toEqual([
      { kind: "row", index: 0 },
      { kind: "row", index: 1 },
    ]);
  });

  it("pinned が行数の外（絞り込みで消えた行）なら無視する", () => {
    expect(renderPlan({ start: 0, end: 1 }, 1, 99)).toEqual([{ kind: "row", index: 0 }]);
  });

  // スペーサーの合計 + 行数 = 全行数（ここがずれるとスクロール量が狂う）
  it("どの組み合わせでも高さの総和が保たれる", () => {
    for (const pinned of [undefined, 0, 3, 12, 19]) {
      for (const start of [0, 4, 15]) {
        const plan = renderPlan({ start, end: Math.min(start + 5, 20) }, 20, pinned);
        const total = plan.reduce((n, i) => n + (i.kind === "spacer" ? i.rows : 1), 0);
        expect(total).toBe(20);
      }
    }
  });
});
