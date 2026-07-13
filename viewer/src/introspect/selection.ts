/**
 * 適用範囲の選択と依存関係の整合（K-10 / 詳細設計 §5.2）。
 *
 * UI 側で自動的に整合させるが、サーバー側でも同じ規則で再検証する
 * （クライアントを信用しない）。ここでの整合は「ユーザーが破綻した選択を
 * 作れないようにする」ための先回りであり、正しさの拠り所ではない。
 */
import { flatten, type DiffItem } from "./types";

/** 既定は全選択（§5.1）。 */
export function defaultSelection(items: DiffItem[]): Set<string> {
  const out = new Set<string>();
  for (const item of flatten(items).values()) {
    if (item.selectable) out.add(item.id);
  }
  return out;
}

function descendants(item: DiffItem): DiffItem[] {
  const out: DiffItem[] = [];
  const walk = (list: DiffItem[]) => {
    for (const c of list) {
      out.push(c);
      walk(c.children);
    }
  };
  walk(item.children);
  return out;
}

/**
 * 1項目のチェックを切り替え、依存関係を保った選択集合を返す。
 * - ON: 必要な前提項目（requires）と、配下の項目をまとめて選ぶ（R-2 / R-3）
 * - OFF: この項目を前提にしている項目と、配下の項目をまとめて外す（R-1）
 */
export function toggle(items: DiffItem[], selection: Set<string>, id: string): Set<string> {
  const index = flatten(items);
  const item = index.get(id);
  if (!item || !item.selectable) return selection;

  const next = new Set(selection);
  if (selection.has(id)) {
    remove(index, next, id);
  } else {
    add(index, next, id);
    for (const child of descendants(item)) {
      if (child.selectable) add(index, next, child.id);
    }
  }
  return next;
}

function add(index: Map<string, DiffItem>, selection: Set<string>, id: string): void {
  if (selection.has(id)) return;
  const item = index.get(id);
  if (!item) return;
  if (item.selectable) selection.add(id);
  for (const required of item.requires) {
    add(index, selection, required);
  }
}

function remove(index: Map<string, DiffItem>, selection: Set<string>, id: string): void {
  if (!selection.has(id)) return;
  selection.delete(id);
  const item = index.get(id);
  if (item) {
    for (const child of descendants(item)) {
      selection.delete(child.id);
    }
  }
  // この項目を前提にしている項目は成立しなくなるため、連動して外す
  for (const other of index.values()) {
    if (other.selectable && selection.has(other.id) && other.requires.includes(id)) {
      remove(index, selection, other.id);
    }
  }
}

/** クイックフィルタ（§5.1）。 */
export function quickSelect(
  items: DiffItem[],
  mode: "all" | "none" | "addedOnly" | "withoutRemoved",
): Set<string> {
  if (mode === "all") return defaultSelection(items);
  if (mode === "none") return new Set();

  const out = new Set<string>();
  const index = flatten(items);
  for (const table of items) {
    if (mode === "addedOnly" && table.change !== "added") continue;
    if (mode === "withoutRemoved" && table.change === "removed") continue;
    if (table.selectable) out.add(table.id);
    for (const child of descendants(table)) {
      if (!child.selectable) continue;
      if (mode === "withoutRemoved" && child.change === "removed") continue;
      out.add(child.id);
    }
  }
  // 前提項目を補う（「削除を除く」で FK 追加だけが残る、といった破綻を防ぐ）
  for (const id of [...out]) {
    add(index, out, id);
  }
  return out;
}

/** 親（テーブル）のチェック状態: すべて選択 / 一部選択 / 未選択。 */
export function tableState(
  item: DiffItem,
  selection: Set<string>,
): "checked" | "partial" | "unchecked" {
  if (item.selectable) {
    if (!selection.has(item.id)) return "unchecked";
  }
  const children = descendants(item).filter((c) => c.selectable);
  if (children.length === 0) {
    return item.selectable ? "checked" : "checked";
  }
  const selected = children.filter((c) => selection.has(c.id)).length;
  if (selected === 0) return item.selectable && selection.has(item.id) ? "partial" : "unchecked";
  if (selected === children.length) return "checked";
  return "partial";
}

/** 選択によって書き換わるファイル数（フッタに常時表示する。§5.1）。 */
export function affectedFileCount(items: DiffItem[], selection: Set<string>): number {
  const files = new Set<string>();
  for (const table of items) {
    if (table.kind !== "table") continue;
    const applies =
      table.change === "renamed" ||
      (table.selectable && selection.has(table.id)) ||
      descendants(table).some((c) => c.selectable && selection.has(c.id));
    if (applies) files.add(table.target);
  }
  // schema/**（テーブル数）+ manifest.js + index.js
  return files.size === 0 ? 0 : files.size + 2;
}
