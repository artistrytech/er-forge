/**
 * アプリ全体の状態（zustand）。
 * データ本体（manifest / index / dictionary / tables / diagrams）はローダーが書き込む。
 * 個人設定（言語・表示形式）は静的モードではメモリ保持のみ（設計書 §2.3）。
 */
import { create } from "zustand";
import { detectLang, type Lang } from "../i18n/messages";
import type { NameDisplay } from "./logicalName";
import type { Config, Diagram, Dictionary, IndexData, Manifest, Table } from "./types";
import type { WorkspaceRef } from "./workspace";

/** 描画を止める致命的な状態（A-04 / §3.6） */
export type Fatal =
  | { kind: "no-data" }
  | { kind: "bad-data"; file: string }
  | { kind: "data-older"; version: number }
  | { kind: "data-newer"; version: number }
  | { kind: "empty" }
  /** ワークスペースが1つも無い（初回起動。サーバーモードなら welcome 画面へ） */
  | { kind: "no-workspace" }
  /** データ配信がトークン不一致で拒まれた（§8.5）。「データが無い」と区別する */
  | { kind: "forbidden" }
  /** URL が存在しないワークスペースを指している（一覧への導線を出す） */
  | { kind: "workspace-not-found"; id: string };

/** 詳細ダイアログで開ける制約の種類（リレーション以外。テーブル詳細の虫眼鏡から開く） */
export type ConstraintKind = "unique" | "index" | "logicalUnique";

/** 左パネルのレーン（アイコンレール: ページ / 全て / 検索） */
export type PanelLane = "pages" | "all" | "search";

/** ER図上の一時的なダイアログ（URL を持たない。設計書 §4.4） */
export type DialogState =
  | { type: "table"; id: string }
  | { type: "relation"; id: string }
  /**
   * リレーションの編集（ER図の編集モード中にエッジをダブルクリックしたとき）。
   * 閲覧ルートからは開かない = 閲覧は読むだけ、を崩さない（P-11）
   */
  | { type: "relationEdit"; id: string }
  /** 名前を持たない制約もあるため、テーブル内の位置（at）で指す */
  | { type: "constraint"; tableId: string; kind: ConstraintKind; at: number };

export interface AppState {
  lang: Lang;
  nameDisplay: NameDisplay;
  /** null = 判定中 */
  serverMode: boolean | null;
  /**
   * サーバー（erd-server.jar）のリリースバージョン。/__erd/health が返す。
   * null = 静的モード、または取得できなかった。
   * index.html と jar は別々に差し替えられるため、ビューア側の APP_VERSION と
   * 食い違うことがある。information はその不一致を表示する（A-02）。
   */
  serverVersion: string | null;

  /** ワークスペース一覧（workspaces.js。プルダウンの中身） */
  workspaces: WorkspaceRef[];
  /** 表示中のワークスペース（段階0 で決まる。切替はフルリロードなので以後変わらない） */
  workspaceId: string | null;
  /** 最後に開いたワークスペース（URL にワークスペースが無いときの復元先。タブ単位） */
  lastWorkspaceId: string | null;

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
   * これを復元する。リロードをまたいで復元できるよう sessionStorage に保持する（タブ単位）。
   */
  lastTableId: string | null;
  /** 最後に閲覧した ER図ページ。#/erd（ページ未指定）を開いたときにこれを復元する。 */
  lastDiagramId: string | null;
  /**
   * 直近の逆生成で追加されたテーブル（K-12 §7.2）。未配置トレイで「NEW」として先頭に寄せる。
   * **セッション限定のメモリ状態**であり、リロードで消える（ファイルには残さない。
   * 「未配置」自体は index.tables[].diagrams が空という導出結果であって、フラグではない）。
   */
  recentTables: string[];
  /**
   * 左パネルのページ情報編集モード（ページの追加・改名・並び替え・削除）。
   *
   * これらは**即時にファイルへ書かれる**（ER図の配置編集のような「保存」を挟まない）ため、
   * ER図の編集セッションとは別の導線に分ける。ER編集中は開始できず、逆にこのモード中は
   * ER図・テーブルの編集を開始できない（どちらの意味で編集中なのかを曖昧にしない）。
   * ER用・テーブル用の左パネルは2つ同時にマウントされるため、状態はここで共有する。
   */
  pageInfoEditing: boolean;
  /**
   * テーブル画面側の左パネルの選択状態（レーン / 「ページ」レーンで選択中のページ）。
   *
   * #/tables を開いたときに開く 1 件（回答E）を**パネルが見せている一覧と一致させる**ために、
   * App からも参照できるようここへ置く。ER用パネルのレーン・選択ページはルートに追従するか
   * インスタンス内で完結するため、ここには載せない。
   * ページの null は「まだ選んでいない」で、既定の先頭ページは参照側（useTablesPanelPage）が解決する。
   */
  tablesPanelLane: PanelLane;
  tablesPanelPage: string | null;

  setLang(lang: Lang): void;
  setNameDisplay(mode: NameDisplay): void;
  /** 表示するワークスペースの確定（ローダーの段階0）。復元値もここで読み直す */
  setWorkspace(workspaceId: string): void;
  setWorkspaces(workspaces: WorkspaceRef[]): void;
  openDialog(dialog: DialogState): void;
  closeDialog(): void;
  setSearchOpen(open: boolean): void;
  setNotice(notice: string | null): void;
  setCurrentDiagramId(id: string | null): void;
  /** 一時通知。variant="error" は赤系で少し長く表示する（M-01） */
  addToast(text: string, variant?: "info" | "error"): void;
  setRecentTables(ids: string[]): void;
  setPageInfoEditing(editing: boolean): void;
  setLastTableId(id: string | null): void;
  setLastDiagramId(id: string | null): void;
  setTablesPanelLane(lane: PanelLane): void;
  setTablesPanelPage(id: string | null): void;
}

/**
 * 最後に閲覧したテーブル / ページの保持キー（**タブ単位**。存在しない ID は読み込み側で無視する）。
 * sessionStorage に置くため、リロード・ワークスペース切替では復元されるが、
 * 別タブ・タブを閉じた後は引き継がない（別タブは既定の着地点から始まる）。
 *
 * テーブル・ページはワークスペースごとに別物なので、キーにワークスペース ID を含める。
 * ID を変更した場合は追随させない（古いキーは放置。実害は「最後に見たページ」が1回失われるだけ）。
 */
const LAST_TABLE_KEY = "erd-last-table";
const LAST_DIAGRAM_KEY = "erd-last-diagram";
/** 最後に開いたワークスペース（URL にワークスペースが無いときの復元先） */
const LAST_WORKSPACE_KEY = "erd-last-workspace";
/** リロードをまたいで出すトースト（データリセット・ワークスペース削除の完了通知） */
const PENDING_TOAST_KEY = "erd-pending-toast";

function scopedKey(key: string, workspaceId: string | null): string {
  return workspaceId === null ? key : `${key}:${workspaceId}`;
}
/** ユーザ独自設定（言語・表示名）の永続化キー（設定メニューから変更・localStorage 保存） */
const LANG_KEY = "erd-lang";
const NAME_DISPLAY_KEY = "erd-name-display";

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
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

function persistOrRemoveSession(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage 不可でもメモリ内では復元できる（致命的ではない）
  }
}

export const useAppStore = create<AppState>((set) => ({
  // ユーザ独自設定があれば優先し、無ければ環境から判定・既定を使う（設定メニュー / L-04）
  lang:
    readStoredLang() ??
    detectLang(typeof navigator !== "undefined" ? navigator.languages ?? [] : []),
  nameDisplay: readStoredNameDisplay() ?? "both",
  serverMode: null,
  serverVersion: null,

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
  pageInfoEditing: false,
  tablesPanelLane: "pages",
  tablesPanelPage: null,
  workspaces: [],
  workspaceId: null,
  lastWorkspaceId: readSession(LAST_WORKSPACE_KEY),
  lastTableId: null,
  lastDiagramId: null,

  /**
   * 表示するワークスペースが決まった時点で、そのワークスペース向けの復元値を読み込む
   * （ローダーの段階0 から1回だけ呼ぶ）。
   */
  setWorkspace: (workspaceId) => {
    persistOrRemoveSession(LAST_WORKSPACE_KEY, workspaceId);
    set({
      workspaceId,
      lastWorkspaceId: workspaceId,
      lastTableId: readSession(scopedKey(LAST_TABLE_KEY, workspaceId)),
      lastDiagramId: readSession(scopedKey(LAST_DIAGRAM_KEY, workspaceId)),
    });
  },
  setWorkspaces: (workspaces) => set({ workspaces }),

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
  setPageInfoEditing: (pageInfoEditing) => set({ pageInfoEditing }),
  setLastTableId: (lastTableId) => {
    set((s) => {
      persistOrRemoveSession(scopedKey(LAST_TABLE_KEY, s.workspaceId), lastTableId);
      return { lastTableId };
    });
  },
  setLastDiagramId: (lastDiagramId) => {
    set((s) => {
      persistOrRemoveSession(scopedKey(LAST_DIAGRAM_KEY, s.workspaceId), lastDiagramId);
      return { lastDiagramId };
    });
  },
  setTablesPanelLane: (tablesPanelLane) => set({ tablesPanelLane }),
  setTablesPanelPage: (tablesPanelPage) => set({ tablesPanelPage }),
  addToast: (text, variant = "info") => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, variant }] }));
    setTimeout(() => {
      useAppStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, variant === "error" ? 8000 : 5000);
  },
}));

let toastSeq = 0;

/**
 * リロード後に出すトーストを預ける（データリセット・ワークスペース削除。§11）。
 *
 * これらの操作は完了後に必ずページを読み込み直すため、その場で出したトーストは
 * すぐ消えてしまう。sessionStorage に預けて、起動後に一度だけ出す。
 */
export function queueToastAfterReload(text: string): void {
  persistOrRemoveSession(PENDING_TOAST_KEY, text);
}

/** 預けたトーストがあれば出して消す（App のマウント時に1回だけ呼ぶ） */
export function flushPendingToast(): void {
  const text = readSession(PENDING_TOAST_KEY);
  if (text === null || text === "") return;
  persistOrRemoveSession(PENDING_TOAST_KEY, null);
  useAppStore.getState().addToast(text);
}

/** 全テーブル数（manifest 由来）。進捗表示（A-03）に使う */
export function totalTableCount(state: Pick<AppState, "manifest">): number {
  return Object.keys(state.manifest?.tables ?? {}).length;
}
