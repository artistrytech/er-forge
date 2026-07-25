/**
 * アプリ全体の状態（zustand）。
 * データ本体（manifest / index / dictionary / tables / diagrams）はローダーが書き込む。
 * 個人設定（言語・表示形式）は静的モードではメモリ保持のみ（設計書 §2.3）。
 */
import { create } from "zustand";
import { detectLang, type Lang } from "../i18n/messages";
import type { NameDisplay } from "./logicalName";
import type { Config, Diagram, Dictionary, IndexData, Manifest, Table } from "./types";

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
  /** テーブル無視リスト（K-15）。サーバーモードで逆生成の画面を開いたときに遅延ロードする */
  config: Config | null;
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
  /** 表示中の ER図ページ（SSE の外部変更分岐が「現在のページか」を判定するために使う） */
  currentDiagramId: string | null;
  toasts: { id: number; text: string; variant: "info" | "error" }[];
  /**
   * 最後に閲覧したテーブル。テーブル一覧（#/tables）を開いたとき、先頭ではなく
   * これを復元する。リロードをまたいで復元できるよう localStorage に保持する。
   */
  lastTableId: string | null;
  /**
   * 直近の逆生成で追加されたテーブル（K-12 §7.2）。未配置トレイで「NEW」として先頭に寄せる。
   * **セッション限定のメモリ状態**であり、リロードで消える（ファイルには残さない。
   * 「未配置」自体は index.tables[].diagrams が空という導出結果であって、フラグではない）。
   */
  recentTables: string[];

  setLang(lang: Lang): void;
  setNameDisplay(mode: NameDisplay): void;
  openDialog(dialog: DialogState): void;
  closeDialog(): void;
  setSearchOpen(open: boolean): void;
  setNotice(notice: string | null): void;
  setCurrentDiagramId(id: string | null): void;
  /** 一時通知。variant="error" は赤系で少し長く表示する（M-01） */
  addToast(text: string, variant?: "info" | "error"): void;
  setRecentTables(ids: string[]): void;
  setLastTableId(id: string | null): void;
}

/** 最後に閲覧したテーブルの永続化キー（origin 単位。存在しない ID は読み込み側で無視する） */
const LAST_TABLE_KEY = "erd-last-table";
/** ユーザ独自設定（言語・表示名）の永続化キー（設定メニューから変更・localStorage 保存） */
const LANG_KEY = "erd-lang";
const NAME_DISPLAY_KEY = "erd-name-display";

function readLastTableId(): string | null {
  try {
    return localStorage.getItem(LAST_TABLE_KEY);
  } catch {
    return null;
  }
}

function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "ja" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

function readStoredNameDisplay(): NameDisplay | null {
  try {
    const v = localStorage.getItem(NAME_DISPLAY_KEY);
    return v === "both" || v === "logical" || v === "physical" ? v : null;
  } catch {
    return null;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage 不可でもメモリ内では有効（致命的ではない）
  }
}

export const useAppStore = create<AppState>((set) => ({
  // ユーザ独自設定があれば優先し、無ければ環境から判定・既定を使う（設定メニュー / L-04）
  lang:
    readStoredLang() ??
    detectLang(typeof navigator !== "undefined" ? navigator.languages ?? [] : []),
  nameDisplay: readStoredNameDisplay() ?? "both",
  serverMode: null,

  fatal: null,
  manifest: null,
  index: null,
  dictionary: null,
  config: null,
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
  currentDiagramId: null,
  toasts: [],
  recentTables: [],
  lastTableId: readLastTableId(),

  setLang: (lang) => {
    set({ lang });
    persist(LANG_KEY, lang);
  },
  setNameDisplay: (nameDisplay) => {
    set({ nameDisplay });
    persist(NAME_DISPLAY_KEY, nameDisplay);
  },
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setNotice: (notice) => set({ notice }),
  setCurrentDiagramId: (currentDiagramId) => set({ currentDiagramId }),
  setRecentTables: (recentTables) => set({ recentTables }),
  setLastTableId: (lastTableId) => {
    set({ lastTableId });
    try {
      if (lastTableId === null) localStorage.removeItem(LAST_TABLE_KEY);
      else localStorage.setItem(LAST_TABLE_KEY, lastTableId);
    } catch {
      // localStorage 不可でもメモリ内では復元できる（致命的ではない）
    }
  },
  addToast: (text, variant = "info") => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, variant }] }));
    setTimeout(() => {
      useAppStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, variant === "error" ? 8000 : 5000);
  },
}));

let toastSeq = 0;

/** 全テーブル数（manifest 由来）。進捗表示（A-03）に使う */
export function totalTableCount(state: Pick<AppState, "manifest">): number {
  return Object.keys(state.manifest?.tables ?? {}).length;
}
