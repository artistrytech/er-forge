/**
 * キャンバス上の一時的な選択状態（C-07 / C-08 / E-05）。
 *
 * 選択・ハイライトをノード / エッジの data に入れると、選択のたびに nodes 配列を
 * 作り直すことになり、React Flow が計測済み寸法を失って再計測が走る
 * （ノードが一瞬 visibility:hidden になり、ダブルクリックが成立しなくなる）。
 * そのためノード / エッジのコンポーネントがこのストアを直接購読する。
 */
import { create } from "zustand";
import type { Relation } from "../model/types";

export type CanvasSelection =
  | { type: "node"; id: string }
  | { type: "edge"; id: string }
  | null;

interface CanvasState {
  selection: CanvasSelection;
  relatedNodes: ReadonlySet<string>;
  relatedEdges: ReadonlySet<string>;
  select(selection: CanvasSelection, relations: readonly Relation[]): void;
  clear(): void;
}

const EMPTY: ReadonlySet<string> = new Set();

export const useCanvasStore = create<CanvasState>((set) => ({
  selection: null,
  relatedNodes: EMPTY,
  relatedEdges: EMPTY,
  select: (selection, relations) => {
    if (selection === null) {
      set({ selection: null, relatedNodes: EMPTY, relatedEdges: EMPTY });
      return;
    }
    const relatedNodes = new Set<string>();
    const relatedEdges = new Set<string>();
    if (selection.type === "node") {
      relatedNodes.add(selection.id);
      for (const r of relations) {
        if (r.from === selection.id || r.to === selection.id) {
          relatedEdges.add(r.id);
          relatedNodes.add(r.from);
          relatedNodes.add(r.to);
        }
      }
    } else {
      const r = relations.find((x) => x.id === selection.id);
      if (r) {
        relatedEdges.add(r.id);
        relatedNodes.add(r.from);
        relatedNodes.add(r.to);
      }
    }
    set({ selection, relatedNodes, relatedEdges });
  },
  clear: () => set({ selection: null, relatedNodes: EMPTY, relatedEdges: EMPTY }),
}));
