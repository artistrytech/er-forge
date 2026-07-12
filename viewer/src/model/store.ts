/**
 * アプリ全体の状態（zustand）。
 * データ本体（manifest / index / dictionary / tables / diagrams）はローダーが書き込む。
 * 個人設定（言語・表示形式）は静的モードではメモリ保持のみ（設計書 §2.3）。
 */
import { create } from "zustand";
import { detectLang, type Lang } from "../i18n/messages";
import type { NameDisplay } from "./logicalName";
import type { Diagram, Dictionary, IndexData, Manifest, Table } from "./types";

/** 描画を止める致命的な状態（A-04 / §3.6） */
export type Fatal =
  | { kind: "no-data" }
  | { kind: "bad-data"; file: string }
  | { kind: "data-older"; version: number }
  | { kind: "data-newer"; version: number }
  | { kind: "empty" };

/** ER図上の一時的なダイアログ（URL を持たない。設計書 §4.4） */
export type DialogState =
  | { type: "table"; id: string }
  | { type: "relation"; id: string };

export interface AppState {
  lang: Lang;
  nameDisplay: NameDisplay;
  /** null = 判定中 */
  serverMode: boolean | null;

  fatal: Fatal | null;
  manifest: Manifest | null;
  index: IndexData | null;
  dictionary: Dictionary | null;
  tables: Record<string, Table>;
  tableErrors: Record<string, string>;
  diagrams: Record<string, Diagram>;
  diagramErrors: Record<string, string>;
  /** 段階2（manifest + index + dictionary）完了 = 画面を描いてよい */
  ready: boolean;
  loadedTableCount: number;
  failedTableCount: number;

  dialog: DialogState | null;
  searchOpen: boolean;
  /** 編集画面へのアクセス等で表示する一時通知（リロードで消えてよい） */
  notice: string | null;

  setLang(lang: Lang): void;
  setNameDisplay(mode: NameDisplay): void;
  openDialog(dialog: DialogState): void;
  closeDialog(): void;
  setSearchOpen(open: boolean): void;
  setNotice(notice: string | null): void;
}

export const useAppStore = create<AppState>((set) => ({
  lang: detectLang(typeof navigator !== "undefined" ? navigator.languages ?? [] : []),
  nameDisplay: "both",
  serverMode: null,

  fatal: null,
  manifest: null,
  index: null,
  dictionary: null,
  tables: {},
  tableErrors: {},
  diagrams: {},
  diagramErrors: {},
  ready: false,
  loadedTableCount: 0,
  failedTableCount: 0,

  dialog: null,
  searchOpen: false,
  notice: null,

  setLang: (lang) => set({ lang }),
  setNameDisplay: (nameDisplay) => set({ nameDisplay }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setNotice: (notice) => set({ notice }),
}));

/** 全テーブル数（manifest 由来）。進捗表示（A-03）に使う */
export function totalTableCount(state: Pick<AppState, "manifest">): number {
  return Object.keys(state.manifest?.tables ?? {}).length;
}
