/**
 * 固定行高のウィンドウイング（カラム辞書 P-03 の一覧）。
 *
 * 数百行に入力欄・タグ入力・色選択を並べると、DOM とリスナーが行数に比例して増える。
 * 見えている範囲だけを描き、前後は**高さぶんの空行（スペーサー）**で埋める。
 * `transform` で持ち上げる方式ではなく空行にするのは、`<table>` の列幅計算を壊さないため。
 *
 * **行の高さが揃っていることが前提**（可変にすると実測が要る）。CSS 側で行高を固定し、
 * e2e で実際の行高が {@link ROW_HEIGHT} と一致することを検査している。
 */
import { useEffect, useMemo, useState, type RefObject } from "react";

/** 一覧の行高（px）。CSS（ColumnsPage.module.scss の .row）と必ず一致させること */
export const ROW_HEIGHT = 44;

/** 上下に余分に描く行数。スクロール中の空白と、フォーカス中の行の消失を減らす */
export const OVERSCAN = 8;

export interface VisibleRange {
  /** 最初に描く行（含む） */
  start: number;
  /** 最後に描く行の次（含まない） */
  end: number;
}

export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
  rowHeight: number = ROW_HEIGHT,
  overscan: number = OVERSCAN,
): VisibleRange {
  if (rowCount <= 0 || viewportHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(viewportHeight / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(rowCount, first + visible + overscan);
  return { start, end };
}

export type RenderItem =
  | { kind: "spacer"; rows: number }
  | { kind: "row"; index: number };

/**
 * 描画計画（スペーサーと行の並び）。
 *
 * `pinned` は範囲外でも必ず描く行で、**入力中の行**に使う。仮想化はスクロールで行を
 * unmount するため、これが無いと入力途中（IME 変換中を含む）にスクロールした瞬間に
 * 入力が消える。範囲の前後どちらに落ちても、正しい位置へ差し込む。
 */
export function renderPlan(range: VisibleRange, rowCount: number, pinned?: number): RenderItem[] {
  const indices: number[] = [];
  if (pinned !== undefined && pinned >= 0 && pinned < rowCount && pinned < range.start) {
    indices.push(pinned);
  }
  for (let i = range.start; i < range.end; i++) indices.push(i);
  if (pinned !== undefined && pinned >= range.end && pinned < rowCount) indices.push(pinned);

  const items: RenderItem[] = [];
  let prev = -1;
  for (const index of indices) {
    const gap = index - prev - 1;
    if (gap > 0) items.push({ kind: "spacer", rows: gap });
    items.push({ kind: "row", index });
    prev = index;
  }
  const tail = rowCount - 1 - prev;
  if (tail > 0) items.push({ kind: "spacer", rows: tail });
  return items;
}

/** スクロールコンテナを購読して可視範囲を返す。要素の高さ変化（ウィンドウ分割）にも追随する */
export function useVisibleRange(
  ref: RefObject<HTMLElement | null>,
  rowCount: number,
  rowHeight: number = ROW_HEIGHT,
): VisibleRange {
  const [metrics, setMetrics] = useState({ scrollTop: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = (): void =>
      setMetrics((prev) =>
        prev.scrollTop === el.scrollTop && prev.height === el.clientHeight
          ? prev
          : { scrollTop: el.scrollTop, height: el.clientHeight },
      );
    read();
    el.addEventListener("scroll", read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      observer.disconnect();
    };
  }, [ref]);

  // 参照を安定させる（呼び出し側が範囲を useMemo の依存に使うため）
  return useMemo(
    () => visibleRange(metrics.scrollTop, metrics.height, rowCount, rowHeight),
    [metrics, rowCount, rowHeight],
  );
}
