/**
 * 逆生成のプレビュー / 適用のレスポンス型（K-08〜K-13 詳細設計 §2.1 / §9）。
 * サーバー（Java）の DiffItem / DiffPlan / ApplyResult と 1:1 で対応する。
 *
 * 差分の計算はサーバーの単一実装に集約している（リネーム決定が変わるたびに
 * /plan を呼び直して再計算する）。ここでは受け取ったツリーを描くだけで、
 * 差分ロジックを二重実装しない。
 */

export type Change = "added" | "removed" | "modified" | "renamed" | "unchanged";

export interface Warn {
  code: string;
  message: string | null;
}

export interface DiffItem {
  id: string;
  kind: string;
  change: Change;
  target: string;
  renamedFrom: string | null;
  before: string | null;
  after: string | null;
  selectable: boolean;
  requires: string[];
  forcedBy: string[];
  warnings: Warn[];
  children: DiffItem[];
}

export interface RenameCandidate {
  id: string;
  kind: "table" | "column";
  tableId: string | null;
  from: string;
  to: string;
  confidence: "high" | "medium";
  score: number;
  reason: string;
  alternatives: string[];
}

export interface Guard {
  code: string;
  severity: string;
  message: string;
}

export interface Ignored {
  tableId: string;
  matchedBy: string;
  existsInDb: boolean;
}

export interface Stats {
  added: number;
  removed: number;
  modified: number;
  renamed: number;
  unchanged: number;
  outOfScope: number;
  ignored: number;
}

export interface Preview {
  sessionId: string;
  expiresAt: string;
  source: { product: string; version: string; driver: string };
  baseFingerprint: string;
  stats: Stats;
  items: DiffItem[];
  renameCandidates: RenameCandidate[];
  guards: Guard[];
  ignored: Ignored[];
  outOfScope: string[];
  warnings: string[];
}

export type Decision = "accept" | "reject" | "correct";

export interface RenameDecision {
  id: string;
  decision: Decision;
  to?: string;
}

export interface ApplyResponse {
  revision: string;
  applied: { added: number; removed: number; modified: number; renamed: number };
  skipped: { count: number; itemIds: string[] };
  logicalNamesSeeded: { tables: number; columns: number };
  unplacedTables: string[];
  orphanNodes: { tableId: string; diagrams: string[] }[];
  warnings: { code: string; message: string }[];
}

export interface ConnectionTest {
  product: string;
  version: string;
  driver: string;
  namespaces: string[];
}

export interface DriverInfo {
  className: string;
  version: string;
  source: string;
}

/** 全項目を平坦化する（選択の整合・依存の解決に使う）。 */
export function flatten(items: DiffItem[]): Map<string, DiffItem> {
  const out = new Map<string, DiffItem>();
  const walk = (list: DiffItem[]) => {
    for (const item of list) {
      out.set(item.id, item);
      walk(item.children);
    }
  };
  walk(items);
  return out;
}
