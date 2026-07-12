/**
 * ERD.diagram の決定論的プリンタ（TypeScript 実装）。
 *
 * H-13（静的モードでの座標エクスポート）で使う。サーバー側の
 * erd.core.io.DataFilePrinter#printDiagram とバイト一致すること（INV-3）。
 * 一致は golden fixture（fixtures/core.diagram.*）のテストで保証する。
 */

import { codepointCompare, key, quote } from "./jsText";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface NodeLayout {
  pos: [number, number];
  w?: number | null;
  unknown?: Record<string, JsonValue>;
}

export interface EdgeLayout {
  waypoints?: [number, number][];
  unknown?: Record<string, JsonValue>;
}

export interface DiagramPage {
  id: string;
  title: string;
  order: number;
  nodes: Record<string, NodeLayout>;
  edges: Record<string, EdgeLayout>;
  unknown?: Record<string, JsonValue>;
}

export function printDiagram(d: DiagramPage): string {
  const out: string[] = [];
  out.push("ERD.diagram({");
  out.push(`  id: ${quote(d.id)},`);
  out.push(`  title: ${quote(d.title)},`);
  out.push(`  order: ${d.order},`);

  const nodeIds = Object.keys(d.nodes).sort(codepointCompare);
  if (nodeIds.length > 0) {
    out.push("  nodes: {");
    for (const id of nodeIds) {
      const n = d.nodes[id]!;
      const pairs: string[] = [];
      pairs.push(`pos: [${n.pos[0]}, ${n.pos[1]}]`);
      if (n.w !== undefined && n.w !== null) pairs.push(`w: ${n.w}`);
      pushUnknown(pairs, n.unknown);
      out.push(`    ${key(id)}: ${inlineObject(pairs)},`);
    }
    out.push("  },");
  }

  const edgeIds = Object.keys(d.edges).sort(codepointCompare);
  if (edgeIds.length > 0) {
    out.push("  edges: {");
    for (const id of edgeIds) {
      const e = d.edges[id]!;
      const pairs: string[] = [];
      if (e.waypoints && e.waypoints.length > 0) {
        const pts = e.waypoints.map((p) => `[${p[0]}, ${p[1]}]`).join(", ");
        pairs.push(`waypoints: [${pts}]`);
      }
      pushUnknown(pairs, e.unknown);
      out.push(`    ${key(id)}: ${inlineObject(pairs)},`);
    }
    out.push("  },");
  }

  emitUnknownBlock(out, 1, d.unknown);
  out.push("});");
  return out.join("\n") + "\n";
}

function inlineObject(pairs: string[]): string {
  return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
}

function pushUnknown(pairs: string[], unknown: Record<string, JsonValue> | undefined): void {
  if (!unknown) return;
  for (const [k, v] of Object.entries(unknown)) {
    pairs.push(`${key(k)}: ${inlineValue(v)}`);
  }
}

/** 汎用値のインライン形（erd.core.io.JsValues#inline と同一の出力）。 */
export function inlineValue(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "string") return quote(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(inlineValue).join(", ")}]`;
  const entries = Object.entries(v);
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([k, val]) => `${key(k)}: ${inlineValue(val)}`).join(", ")} }`;
}

function isBlockValue(v: JsonValue): boolean {
  if (Array.isArray(v)) return v.some((el) => typeof el === "object" && el !== null);
  return typeof v === "object" && v !== null && Object.keys(v).length > 0;
}

/** ブロック文脈での未知キーの出力（erd.core.io.DataFilePrinter#emitGeneric と同一）。 */
function emitUnknownBlock(
  out: string[],
  depth: number,
  unknown: Record<string, JsonValue> | undefined,
): void {
  if (!unknown) return;
  for (const [k, v] of Object.entries(unknown)) {
    emitGeneric(out, depth, `${key(k)}: `, v);
  }
}

function emitGeneric(out: string[], depth: number, prefix: string, v: JsonValue): void {
  const indent = "  ".repeat(depth);
  if (!isBlockValue(v)) {
    out.push(`${indent}${prefix}${inlineValue(v)},`);
    return;
  }
  if (Array.isArray(v)) {
    out.push(`${indent}${prefix}[`);
    for (const el of v) emitGeneric(out, depth + 1, "", el);
    out.push(`${indent}],`);
  } else {
    out.push(`${indent}${prefix}{`);
    for (const [k, val] of Object.entries(v as Record<string, JsonValue>)) {
      emitGeneric(out, depth + 1, `${key(k)}: `, val);
    }
    out.push(`${indent}},`);
  }
}
