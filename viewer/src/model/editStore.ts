/**
 * ER図の編集状態（H-01〜H-13 / 詳細設計 H01-H13_layout-edit-sync-undo.md）。
 *
 * 3層の状態モデル（§1.1）:
 * - committed: サーバー上のファイルと一致していると信じている状態（このモジュールの Map）
 * - pending:   まだ書かれていないコマンド列（store の pages[*].pending）
 * - view:      committed + pending。appStore.diagrams に反映し、描画側は常にこれを読む
 *
 * 編集は URL で表す（閲覧ルート `#/erd/<id>` / 編集ルート `#/erd/<id>/edit`。§4.4）。
 * `session` はそのルートに追従する（App が enterEditing / leaveEditing で切り替える）。
 * 編集ロックは設けない（H-11 廃止）。複数タブ・外部変更は SSE のバナー通知（§6）で検知し、
 * 保存時の baseHash 検証（§4.3）で最終的に守る。自動保存はしない（明示保存のみ。H-03）。
 *
 * 不変条件: INV-1 変更を黙って捨てない / INV-2 スナップは入力時 / INV-3 自リビジョン無視 /
 * INV-4 編集はコマンド経由 / INV-5 baseHash 不一致で書かない / INV-6 書き込みは直列。
 */
import { create } from "zustand";
import { translate, type MsgKey } from "../i18n/messages";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, wpath } from "./api";
import { applyCommands, foldToPayload, invert, type Command } from "./commands";
import {
  forceReloadDiagram,
  invalidateTable,
  loadTable,
  reloadDictionary,
  reloadIndex,
  reloadManifest,
} from "./loader";
import { buildDraft, draftToMeta, type MetaDraft } from "./metaDraft";
import { useAppStore } from "./store";
import { currentWorkspaceId } from "./workspace";
import type { Diagram, Table } from "./types";

export type SaveStatus = "saved" | "dirty" | "saving" | "failed";

/** 保存時の競合（409 STALE。§4.3）— 自動でどちらかを選ばない（INV-1） */
export type EditDialog = { type: "conflict"; diagramId: string };

/** ページ管理（I-01〜I-03）の結果。エラーは呼び出し元がフォームに表示する */
export type PageOpResult = { ok: true } | { ok: false; error: string };

export interface PageEdit {
  pending: Command[];
  undo: Command[];
  redo: Command[];
}

const EMPTY_PAGE: PageEdit = { pending: [], undo: [], redo: [] };

/** 「このタブ内では通知しない」（§6.2）。タブを閉じるまで有効 */
const MUTE_KEY = "erd-mute-external";

interface EditState {
  session: "viewing" | "editing";
  status: SaveStatus;
  failMessage: string | null;
  pages: Record<string, PageEdit>;
  pendingCount: number;
  /**
   * 正味の未保存変更があるか（§5.2）。pendingCount は「まだ畳んでいないコマンド数」であり、
   * 移動→Undo のように相殺されると 2 件残るが実質変更なし。これを committed への畳み込み
   * （foldToPayload）で判定し、保存アイコンの活性・タイトルの * ・終了確認に使う。
   */
  netDirty: boolean;
  dialog: EditDialog | null;
  /** 現在ページが外部で更新された（編集ルート滞在中のバナー。§6.2） */
  externalUpdate: { diagramId: string; revision: string } | null;
  exportDiagramId: string | null;

  /** 編集ルートへ入った（App がルートに追従して呼ぶ） */
  enterEditing(): void;
  /** 編集ルートから離脱した。未保存は破棄して committed に戻す（離脱ガードは呼び出し側） */
  leaveEditing(): void;
  closeDialog(): void;

  push(diagramId: string, cmd: Command): void;
  undo(diagramId: string): void;
  redo(diagramId: string): void;

  save(): void;
  retry(): void;
  resolveConflict(action: "overwrite" | "reload"): void;
  /** 外部変更バナー: reload=破棄して再読込 / ignore=無視して編集継続（§6.2） */
  resolveExternal(action: "reload" | "ignore"): void;
  /** このタブ内では以後通知しない（sessionStorage に保持。§6.2） */
  muteExternalForTab(): void;

  openExport(diagramId: string): void;
  closeExport(): void;
  setDragging(dragging: boolean): void;

  /** ページ管理（I-01〜I-03）。書き込みは保存経路と直列化する */
  createPage(id: string, title: string): Promise<PageOpResult>;
  renamePage(diagramId: string, title: string): Promise<PageOpResult>;
  reorderPage(diagramId: string, direction: "up" | "down"): Promise<PageOpResult>;
  deletePage(diagramId: string): Promise<PageOpResult>;

  /**
   * テーブルの削除（J-02）。baseHash は削除確認を出す直前に取得したものを渡す
   * （確認中に外部で書き換わったら 409 で止める。INV-5）。
   * removeNodes=false なら ER図のノードは孤児として残る（K-13）。
   */
  deleteTable(tableId: string, baseHash: string, removeNodes: boolean): Promise<PageOpResult>;
}

// ---------------------------------------------------------- モジュール内部状態

/** committed: 保存済みと信じている各ページの状態（view とは別に保持する） */
const committed = new Map<string, Diagram>();
/** 読み込み時点の各ファイルの内容ハッシュ（保存時の baseHash。§4.3） */
const baseHashes = new Map<string, string>();
/** 自分の書き込みのリビジョン（直近20件。SSE のエコーバック無視に使う。INV-3） */
const myRevisions: string[] = [];
/** ドラッグ中に届いた SSE イベントの保留（§6.2） */
const deferredEvents: { revision: string; files: string[] }[] = [];

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
let inflight = false;
let queuedFlush = false;
let dragging = false;

const RETRY_DELAYS_MS = [1000, 4000, 10_000];

function rememberRevision(rev: string): void {
  myRevisions.push(rev);
  if (myRevisions.length > 20) myRevisions.shift();
}

function pageOf(state: EditState, diagramId: string): PageEdit {
  return state.pages[diagramId] ?? EMPTY_PAGE;
}

function countPending(pages: Record<string, PageEdit>): number {
  return Object.values(pages).reduce((n, p) => n + p.pending.length, 0);
}

/**
 * pending が committed に対して正味の変更を持つか（§5.2）。
 * 例: ノードを動かして Undo で戻すと pending は 2 件残るが、畳み込むと空 = 変更なし。
 */
function hasNetChange(pages: Record<string, PageEdit>): boolean {
  for (const [id, page] of Object.entries(pages)) {
    if (page.pending.length === 0) continue;
    const base = committed.get(id);
    // committed 未確保（読み込み前に触っていない）なら pending をそのまま変更とみなす
    if (!base) return true;
    if (Object.keys(foldToPayload(page.pending, base)).length > 0) return true;
  }
  return false;
}

/** pending 更新後の status / netDirty を求める（保存中・失敗中は M-02 で維持する） */
function statusForPages(current: SaveStatus, pages: Record<string, PageEdit>): {
  status: SaveStatus;
  netDirty: boolean;
} {
  const net = hasNetChange(pages);
  if (!net) {
    // 相殺されて変更なし: 保存中はそのまま、それ以外は「保存済み」に落とす
    return { status: current === "saving" ? "saving" : "saved", netDirty: false };
  }
  return { status: statusAfterEdit(current), netDirty: true };
}

function serverMode(): boolean {
  return useAppStore.getState().serverMode === true;
}

function toast(text: string): void {
  useAppStore.getState().addToast(text);
}

function isMuted(): boolean {
  try {
    return sessionStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/** 初回編集時に committed を確保する（その時点では view == committed） */
function ensureCommitted(diagramId: string): void {
  if (!committed.has(diagramId)) {
    const view = useAppStore.getState().diagrams[diagramId];
    if (view) committed.set(diagramId, view);
  }
}

function setView(diagramId: string, diagram: Diagram): void {
  useAppStore.setState((s) => ({ diagrams: { ...s.diagrams, [diagramId]: diagram } }));
}

// -------------------------------------------------------------------- store

export const useEditStore = create<EditState>((set, get) => ({
  session: "viewing",
  status: "saved",
  failMessage: null,
  pages: {},
  pendingCount: 0,
  netDirty: false,
  dialog: null,
  externalUpdate: null,
  exportDiagramId: null,

  // ---- 編集セッション（H-10 / §2。ルートに追従する） ----

  enterEditing: () => {
    if (get().session === "editing") return;
    set({ session: "editing", failMessage: null });
    // 編集開始時に最新の baseHash を取り直す（§4.3）。静的モードは保存しないため不要
    if (serverMode()) void refreshHashes();
  },

  leaveEditing: () => {
    if (get().session !== "editing") return;
    // 未保存の変更を捨てて committed に戻す（離脱してよいかの確認は呼び出し側の責務）
    const st = get();
    const pages: Record<string, PageEdit> = {};
    for (const [id, page] of Object.entries(st.pages)) {
      if (page.pending.length > 0) {
        const base = committed.get(id);
        if (base) setView(id, base);
      }
      pages[id] = { pending: [], undo: [], redo: [] };
    }
    set({ pages, pendingCount: 0, netDirty: false, session: "viewing", status: "saved", failMessage: null, externalUpdate: null });
  },

  closeDialog: () => set({ dialog: null }),

  // ---- コマンド（INV-4 / H-01 / H-02 / H-05） ----

  push: (diagramId, cmd) => {
    const st = get();
    if (st.session !== "editing") return;
    ensureCommitted(diagramId);
    const view = useAppStore.getState().diagrams[diagramId];
    if (!view) return;
    setView(diagramId, applyCommands(view, [cmd]));
    const page = pageOf(st, diagramId);
    const undoStack = [...page.undo, cmd].slice(-100);
    const pages = {
      ...st.pages,
      [diagramId]: { pending: [...page.pending, cmd], undo: undoStack, redo: [] },
    };
    const next = statusForPages(st.status, pages);
    set({ pages, pendingCount: countPending(pages), status: next.status, netDirty: next.netDirty });
  },

  undo: (diagramId) => {
    const st = get();
    if (st.session !== "editing") return;
    const page = pageOf(st, diagramId);
    const cmd = page.undo[page.undo.length - 1];
    if (!cmd) return;
    const inv = invert(cmd);
    const view = useAppStore.getState().diagrams[diagramId];
    if (!view) return;
    setView(diagramId, applyCommands(view, [inv]));
    const pages = {
      ...st.pages,
      [diagramId]: {
        pending: [...page.pending, inv],
        undo: page.undo.slice(0, -1),
        redo: [...page.redo, cmd],
      },
    };
    const next = statusForPages(st.status, pages);
    set({ pages, pendingCount: countPending(pages), status: next.status, netDirty: next.netDirty });
  },

  redo: (diagramId) => {
    const st = get();
    if (st.session !== "editing") return;
    const page = pageOf(st, diagramId);
    const cmd = page.redo[page.redo.length - 1];
    if (!cmd) return;
    const view = useAppStore.getState().diagrams[diagramId];
    if (!view) return;
    setView(diagramId, applyCommands(view, [cmd]));
    const pages = {
      ...st.pages,
      [diagramId]: {
        pending: [...page.pending, cmd],
        undo: [...page.undo, cmd].slice(-100),
        redo: page.redo.slice(0, -1),
      },
    };
    const next = statusForPages(st.status, pages);
    set({ pages, pendingCount: countPending(pages), status: next.status, netDirty: next.netDirty });
  },

  // ---- 保存（H-03 / H-04 / §4。明示保存のみ） ----

  save: () => {
    void flush();
  },

  retry: () => {
    retryCount = 0;
    void flush();
  },

  resolveConflict: (action) => {
    const st = get();
    const dialog = st.dialog;
    if (dialog?.type !== "conflict") return;
    set({ dialog: null });
    if (action === "overwrite") {
      void overwriteAndSync(dialog.diagramId);
    } else {
      void discardAndReload(dialog.diagramId);
    }
  },

  resolveExternal: (action) => {
    const st = get();
    const ext = st.externalUpdate;
    if (!ext) return;
    set({ externalUpdate: null });
    if (action === "reload") {
      void discardAndReload(ext.diagramId, ext.revision);
    }
    // ignore: バナーを閉じるだけ。編集を続け、保存時に 409 STALE で守られる（§6.2）
  },

  muteExternalForTab: () => {
    try {
      sessionStorage.setItem(MUTE_KEY, "1");
    } catch {
      // sessionStorage 不可でも致命的ではない（バナーが再度出るだけ）
    }
    set({ externalUpdate: null });
  },

  // ---- エクスポート（H-13） ----

  openExport: (diagramId) => set({ exportDiagramId: diagramId }),
  closeExport: () => set({ exportDiagramId: null }),

  setDragging: (d) => {
    dragging = d;
    if (!d && deferredEvents.length > 0) {
      const events = deferredEvents.splice(0);
      for (const ev of events) handleChangeEvent(ev);
    }
  },

  // ---- ページ管理（I-01〜I-03 / §8.2） ----

  createPage: (id, title) =>
    pageOp(() => apiPost(wpath("/diagrams"), { id, title })),

  renamePage: (diagramId, title) =>
    pageOp(async () =>
      apiPatch(wpath(`/diagrams/${encodeURIComponent(diagramId)}`), {
        baseHash: await baseHashOf(diagramId),
        title,
      }),
    ),

  reorderPage: (diagramId, direction) => {
    // order は manifest 上の相対順序でしかないため、隣のページと入れ替える。
    // 2ページ分の書き込みになるが、pageOp が直列化するため順に届く（INV-6）
    const pages = [...(useAppStore.getState().manifest?.diagrams ?? [])].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    const i = pages.findIndex((p) => p.id === diagramId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= pages.length) return Promise.resolve({ ok: true } as PageOpResult);
    const self = pages[i]!;
    const other = pages[j]!;
    const selfOrder = self.order ?? i + 1;
    const otherOrder = other.order ?? j + 1;
    // 同じ order 値だと入れ替えても順序が変わらない（id 順のタイブレークに落ちる）
    const [a, b] = selfOrder === otherOrder
      ? (direction === "up" ? [otherOrder - 1, otherOrder] : [otherOrder + 1, otherOrder])
      : [otherOrder, selfOrder];

    return pageOp(async () =>
      apiPatch(wpath(`/diagrams/${encodeURIComponent(self.id)}`), {
        baseHash: await baseHashOf(self.id),
        order: a,
      }),
    ).then((first) =>
      !first.ok
        ? first
        : pageOp(async () =>
            apiPatch(wpath(`/diagrams/${encodeURIComponent(other.id)}`), {
              baseHash: await baseHashOf(other.id),
              order: b,
            }),
          ),
    );
  },

  deletePage: (diagramId) =>
    pageOp(
      async () =>
        apiDelete(wpath(`/diagrams/${encodeURIComponent(diagramId)}`), {
          baseHash: await baseHashOf(diagramId),
        }),
      () => forgetDiagram(diagramId),
    ),

  // ---- テーブルの削除（J-02 / O-03 詳細設計 §6.2） ----

  // スキーマファイルが消え、manifest.js / index.js が再生成される。ページ管理と同じ派生
  // ファイルを動かすため、同じ直列化された経路に載せる（INV-6）。
  // ノードも消す場合はページファイルも書き換わるので、応答の files を見て読み直す
  deleteTable: (tableId, baseHash, removeNodes) =>
    pageOp(
      () =>
        apiDelete(wpath(`/tables/${encodeURIComponent(tableId)}`), { baseHash, removeNodes }),
      (revision, files) => {
        invalidateTable(tableId);
        const pages = files.filter((f) => f.startsWith("diagrams/"));
        if (pages.length > 0) applyOtherChanges(pages, revision);
      },
    ),
}));

/**
 * ページ管理・テーブル削除の書き込み（I-01〜I-03 / J-02）。レイアウトの保存（flush）と
 * 同じ1本の経路に載せる（INV-6。並行して投げると、後から届いた古い index.js が
 * 新しいものを上書きしうる）。
 *
 * 成功後は manifest / index を読み直す。ページの追加・削除・改名もテーブルの削除も
 * 派生ファイルを動かすため、何が変わったかを判定せず、まとめて追随させる（§8.2 と同じ方針）。
 *
 * @param forget 成功したときに手元のキャッシュから消すもの（manifest / index の再読込より前に
 *   呼ぶ）。書き込まれたファイル（応答の files）を受け取り、必要な追随を自分で決める
 */
async function pageOp(
  request: () => Promise<{ status: number; body: string }>,
  forget?: (revision: string, files: string[]) => void,
): Promise<PageOpResult> {
  if (!serverMode()) {
    return { ok: false, error: t9n("page.editHint") };
  }
  await waitForIdle();
  inflight = true;
  try {
    const res = await request();
    if (res.status === 200) {
      const body = JSON.parse(res.body) as { revision: string; files?: string[] };
      rememberRevision(body.revision);
      forget?.(body.revision, body.files ?? []);
      await Promise.all([reloadManifest(body.revision), reloadIndex(body.revision)]);
      await refreshHashes();
      return { ok: true };
    }
    if (res.status === 403) {
      // トークン不一致（§8.5）。HTTP コードだけでは次の手が分からない
      return { ok: false, error: t9n("save.forbidden") };
    }
    const body = JSON.parse(res.body) as { code?: string; id?: string; message?: string };
    if (body.code === "DUPLICATE_ID") {
      return { ok: false, error: t9n("page.duplicateId", { id: body.id ?? "" }) };
    }
    if (body.code === "STALE") {
      return { ok: false, error: t9n("save.staleReload") };
    }
    return { ok: false, error: body.message ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, error: t9n("save.failed") };
  } finally {
    inflight = false;
    void continueFlush();
  }
}

/** 飛行中の保存が終わるまで待つ（書き込みは常に1本。INV-6） */
async function waitForIdle(): Promise<void> {
  while (inflight) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** 削除されたページのキャッシュ・編集状態を捨てる */
function forgetDiagram(diagramId: string): void {
  committed.delete(diagramId);
  baseHashes.delete(`diagrams/${diagramId}.js`);
  useEditStore.setState((s) => {
    const pages = { ...s.pages };
    delete pages[diagramId];
    return { pages, pendingCount: countPending(pages) };
  });
  useAppStore.setState((s) => {
    const diagrams = { ...s.diagrams };
    delete diagrams[diagramId];
    const diagramErrors = { ...s.diagramErrors };
    delete diagramErrors[diagramId];
    return { diagrams, diagramErrors };
  });
}

/**
 * ELK による自動レイアウト（H-07 / H-08）。書き込みをしない。
 * 返る座標は原点 (0,0) 基準の相対座標であり、ページ上のどこへ置くかは呼び出し側が決める。
 */
export async function requestAutoLayout(
  nodes: { id: string; w: number; h: number }[],
  edges: { from: string; to: string }[],
): Promise<Record<string, [number, number]> | null> {
  if (!serverMode() || nodes.length === 0) return null;
  try {
    const res = await apiPost("/__erd/layout/auto", { nodes, edges });
    if (res.status !== 200) return null;
    const body = JSON.parse(res.body) as { positions?: Record<string, [number, number]> };
    return body.positions ?? null;
  } catch {
    return null;
  }
}

function statusAfterEdit(current: SaveStatus): SaveStatus {
  // 保存失敗中の追加編集は failed のまま（M-02: 失敗表示は消えない）
  return current === "failed" || current === "saving" ? current : "dirty";
}

// ------------------------------------------------------------------ 保存エンジン

/**
 * 書き込みは常に1本だけ（INV-6）。pending のあるページを順に1ページずつ送る。
 * forceFor を指定したページは baseHash の検証をスキップして上書き保存する（§4.3）。
 */
async function flush(forceFor?: string): Promise<void> {
  if (inflight) {
    queuedFlush = true;
    return;
  }
  if (!serverMode()) return;
  const st = useEditStore.getState();
  const entry = forceFor !== undefined
    ? ([forceFor, pageOf(st, forceFor)] as const)
    : Object.entries(st.pages).find(([, p]) => p.pending.length > 0);
  if (!entry || entry[1].pending.length === 0) {
    finishIfIdle();
    return;
  }
  const [diagramId, page] = entry;
  const sent = page.pending;
  const base = committed.get(diagramId);
  if (!base) {
    // committed が無い = 読み込み前に編集されたことはない想定。安全側で何もしない
    return;
  }

  // pending から取り出す（失敗したら先頭に戻す）
  useEditStore.setState((s) => {
    const pages = { ...s.pages, [diagramId]: { ...pageOf(s, diagramId), pending: [] } };
    return { pages, pendingCount: countPending(pages), status: "saving", failMessage: null };
  });

  const nodes = foldToPayload(sent, base);
  if (Object.keys(nodes).length === 0) {
    // 畳み込みの結果、正味の変更なし（例: 動かして Undo で戻した）
    committed.set(diagramId, applyCommands(base, sent));
    inflight = false;
    finishIfIdle();
    void continueFlush();
    return;
  }

  const rel = `diagrams/${diagramId}.js`;
  inflight = true;
  try {
    const res = await apiPatch(wpath(`/diagrams/${diagramId}`), {
      baseHash: baseHashes.get(rel) ?? "",
      force: forceFor === diagramId,
      nodes,
    });
    inflight = false;
    if (res.status === 200) {
      const body = JSON.parse(res.body) as {
        revision: string;
        newHash: string;
        files?: string[];
      };
      rememberRevision(body.revision);
      baseHashes.set(rel, body.newHash);
      committed.set(diagramId, applyCommands(base, sent));
      retryCount = 0;
      // 自分の書き込みは SSE では無視される（INV-3）ため、派生ファイルはここで追随させる。
      // ノードの追加 / 除去（I-04 / I-06）は index.js の tables[].diagrams を動かし、
      // 未配置トレイ（K-12）・サイドバーの所属ページがそれに依存している
      if (body.files?.includes("index.js")) void reloadIndex(body.revision);
      if (body.files?.includes("manifest.js")) void reloadManifest(body.revision);
      finishIfIdle();
      void continueFlush();
    } else if (res.status === 409) {
      restorePending(diagramId, sent);
      useEditStore.setState({ status: "failed", failMessage: null, dialog: { type: "conflict", diagramId } });
    } else {
      restorePending(diagramId, sent);
      scheduleRetry(`HTTP ${res.status}`);
    }
  } catch {
    inflight = false;
    restorePending(diagramId, sent);
    scheduleRetry("network");
  }
}

function continueFlush(): Promise<void> {
  const st = useEditStore.getState();
  if (queuedFlush || st.pendingCount > 0) {
    queuedFlush = false;
    return flush();
  }
  return Promise.resolve();
}

function restorePending(diagramId: string, sent: Command[]): void {
  useEditStore.setState((s) => {
    const page = pageOf(s, diagramId);
    const pages = { ...s.pages, [diagramId]: { ...page, pending: [...sent, ...page.pending] } };
    return { pages, pendingCount: countPending(pages) };
  });
}

function finishIfIdle(): void {
  const st = useEditStore.getState();
  // 相殺で正味変更なしなら「保存済み」に落とす（pending が残っていても畳めば空）
  const net = hasNetChange(st.pages);
  if (!net) {
    useEditStore.setState({ status: "saved", failMessage: null, netDirty: false });
  } else {
    useEditStore.setState({ status: "dirty", netDirty: true });
  }
}

/** 自動リトライ 1s → 4s → 10s（最大3回）。以後は手動のみ。未保存はメモリに保持（M-02） */
function scheduleRetry(reason: string): void {
  useEditStore.setState({ status: "failed", failMessage: reason });
  if (retryTimer !== null) clearTimeout(retryTimer);
  if (retryCount >= RETRY_DELAYS_MS.length) return;
  const delay = RETRY_DELAYS_MS[retryCount]!;
  retryCount += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flush();
  }, delay);
}

// ------------------------------------------------ 外部変更の反映（H-09 / SSE / §6）

let eventSource: EventSource | null = null;

/** サーバーモードで1回だけ呼ぶ（boot 後）。SSE を張り、外部変更を反映する */
export function connectEvents(): void {
  if (eventSource !== null || !serverMode()) return;
  eventSource = new EventSource(`/__erd/events?t=${encodeURIComponent(apiTokenForEvents())}`);
  eventSource.addEventListener("change", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data as string) as {
        workspaceId?: string;
        revision: string;
        files: string[];
      };
      // 別のワークスペースの変更は自分には関係ない（ファイル名は重なる: index.js など）
      if (data.workspaceId !== undefined && data.workspaceId !== currentWorkspaceId()) return;
      handleChangeEvent(data);
    } catch {
      // 壊れたイベントは無視する
    }
  });
}

function apiTokenForEvents(): string {
  return new URLSearchParams(location.search).get("t") ?? "";
}

function handleChangeEvent(ev: { revision: string; files: string[] }): void {
  // 自分の書き込みが監視に引っかかっただけなら何もしない（INV-3）
  if (myRevisions.includes(ev.revision)) return;
  if (dragging) {
    deferredEvents.push(ev);
    return;
  }

  const currentId = useAppStore.getState().currentDiagramId;
  const currentRel = currentId !== null ? `diagrams/${currentId}.js` : null;
  const others = ev.files.filter((f) => f !== currentRel);
  const touchesCurrent = currentRel !== null && ev.files.includes(currentRel);

  if (others.length > 0) {
    applyOtherChanges(others, ev.revision);
  }
  if (touchesCurrent && currentId !== null) {
    const editing = useEditStore.getState().session === "editing";
    if (editing) {
      // 編集ルート滞在中: 自動で何もしない。バナーで選ばせる（§6.2 / INV-1）。
      // 「このタブ内では通知しない」が選ばれていれば静かに据え置く（保存時 409 で守られる）
      if (!isMuted()) {
        useEditStore.setState({ externalUpdate: { diagramId: currentId, revision: ev.revision } });
      }
    } else {
      // 閲覧ルート（未保存なし）: 静かに再読込する
      void silentReloadCurrent(currentId, ev.revision);
    }
  } else if (others.length > 0) {
    toast(t9n("toast.externalApplied"));
  }
}

/** 現在ページ以外の変更: 静かに反映する（§6.2 左列） */
function applyOtherChanges(files: string[], revision: string): void {
  const manifest = useAppStore.getState().manifest;
  const pathToTable = new Map<string, string>();
  for (const [id, path] of Object.entries(manifest?.tables ?? {})) {
    pathToTable.set(path, id);
  }
  for (const rel of files) {
    if (rel === "index.js") {
      void reloadIndex(revision);
    } else if (rel === "dictionary.js") {
      void reloadDictionary(revision);
    } else if (rel === "manifest.js") {
      void reloadManifest(revision);
    } else if (rel.startsWith("schema/")) {
      const tableId = pathToTable.get(rel);
      if (tableId !== undefined) invalidateTable(tableId);
    } else if (rel.startsWith("diagrams/")) {
      const id = rel.slice("diagrams/".length).replace(/\.js$/, "");
      if (useAppStore.getState().diagrams[id]) {
        committed.delete(id);
        clearStacks(id);
        void forceReloadDiagram(id, revision);
      }
    }
  }
  void refreshHashes();
}

/** 現在ページを静かに再読込し、Undo スタックを破棄する（§5.3 / §6.2） */
async function silentReloadCurrent(diagramId: string, revision: string): Promise<void> {
  committed.delete(diagramId);
  clearStacks(diagramId);
  await forceReloadDiagram(diagramId, revision);
  await refreshHashes();
}

/**
 * 「自分の内容で上書き保存」（§4.3）: force で保存したあと、現在ページをファイルから
 * 読み直して view を収束させる。部分更新のため、自分が触っていないノードの外部変更は
 * ファイルに残っており、再読込しないと画面とファイルが乖離したままになる。
 * Undo スタックは維持する（自分の履歴は依然として有効。§5.3）。
 */
async function overwriteAndSync(diagramId: string): Promise<void> {
  await flush(diagramId);
  if (useEditStore.getState().status !== "saved") return; // 失敗時は通常の失敗導線に乗る
  committed.delete(diagramId);
  await forceReloadDiagram(diagramId, String(Date.now()));
  await refreshHashes();
}

/** 409 / 外部変更バナーで「破棄して再読込」を選んだとき */
async function discardAndReload(diagramId: string, revision?: string): Promise<void> {
  committed.delete(diagramId);
  clearStacks(diagramId);
  await forceReloadDiagram(diagramId, revision);
  await refreshHashes();
  useEditStore.setState((s) => {
    const net = hasNetChange(s.pages);
    return { status: net ? "dirty" : "saved", failMessage: null, netDirty: net };
  });
  toast(t9n("toast.undoCleared"));
}

function clearStacks(diagramId: string): void {
  useEditStore.setState((s) => {
    const pages = { ...s.pages, [diagramId]: { pending: [], undo: [], redo: [] } };
    return { pages, pendingCount: countPending(pages) };
  });
}

/**
 * ページファイルの baseHash を返す。まだ一度も取っていなければ取り直す。
 *
 * ページ管理（I-01〜I-03）は ER図の編集セッションの外（閲覧中のダイアログ）から動くため、
 * enterEditing 起点の refreshHashes を当てにできない。空文字のまま送ると必ず 409 STALE に
 * なり、画面を再読込しても直らない（再読込しても編集セッションには入らないため）。
 * 手元にハッシュがあるときは触らない（外部変更の検出＝INV-5 はそのまま効く）。
 */
async function baseHashOf(diagramId: string): Promise<string> {
  const rel = `diagrams/${diagramId}.js`;
  if (!baseHashes.has(rel)) await refreshHashes();
  return baseHashes.get(rel) ?? "";
}

/** ページ管理ダイアログを開いた時点の baseHash を取り直す（§4.3 の「編集開始時」に相当） */
export function refreshBaseHashes(): void {
  if (serverMode()) void refreshHashes();
}

async function refreshHashes(): Promise<void> {
  try {
    const res = await apiGet(wpath("/project"));
    if (res.status !== 200) return;
    const body = JSON.parse(res.body) as { files?: Record<string, string> };
    baseHashes.clear();
    for (const [rel, hash] of Object.entries(body.files ?? {})) {
      baseHashes.set(rel, hash);
    }
  } catch {
    // 保存時に 409 で検出されるため、ここでの失敗は致命的ではない
  }
}

// トースト文言はコンポーネント外から出すため、ここで直接解決する
// （i18n フックは React 専用。キーは messages.ts に定義済み）
function t9n(key: MsgKey, vars?: Record<string, string | number>): string {
  return translate(useAppStore.getState().lang, key, vars);
}

// -------------------------------------------------------- タブ閉じ・離脱（§2.1）

export function installUnloadHandlers(): void {
  // 未保存があってもブラウザのリロード・タブ閉じ・他ページへの遷移は妨げない方針
  // （確認は「編集を終了」操作に限定する）。以前の beforeunload ガードは撤廃した。
}

// ---------------------------------------- 他画面（テーブル編集・一括編集）との共有

/** フォームの保存が発行したリビジョンを記録し、SSE のエコーバックを無視させる（INV-3） */
export function rememberOwnRevision(revision: string): void {
  rememberRevision(revision);
}

/** {@link saveTableMeta} の結果。stale = 他で書き換えられていた（再取得してやり直す） */
export type TableSaveResult = { ok: true } | { ok: false; message: string; stale?: boolean };

/**
 * テーブルの meta を1件だけ書き換えて即時保存する（ER図からの論理FK編集・カーディナリティ設定）。
 *
 * テーブル編集画面（TableEdit）が「開いて編集して明示保存」するのに対し、こちらは
 * **ダイアログの確定 = 1回の保存**で完結する。ER図の配置編集（コマンド + Undo + 明示保存）
 * とは別の経路であり、Undo の対象にもならない。
 *
 * 書き込みはレイアウト保存・ページ管理と同じ1本の経路に載せる（INV-6）。並行して投げると
 * 派生ファイル（index.js）の再生成が競合し、古い内容で上書きされうる。
 *
 * @param edit 読み直した内容から作ったドラフトを書き換えて返す。null を返すと中止する
 *   （対象の制約が見つからない = 他で変更された、など）
 */
export async function saveTableMeta(
  tableId: string,
  edit: (draft: MetaDraft, table: Table) => MetaDraft | null,
): Promise<TableSaveResult> {
  if (!serverMode()) return { ok: false, message: t9n("page.editHint") };
  await waitForIdle();
  inflight = true;
  try {
    // baseHash は「読み込んだ内容」に対して取る（§8.4）。順序を逆にすると、
    // 読み込んだ後・ハッシュを取る前の変更を検出できない
    invalidateTable(tableId);
    const table = await loadTable(tableId);
    if (!table) return { ok: false, message: t9n("relationEdit.tableGone", { id: tableId }) };
    const head = await apiGet(wpath(`/tables/${encodeURIComponent(tableId)}`));
    if (head.status === 403) return { ok: false, message: t9n("save.forbidden") };
    if (head.status !== 200) {
      return { ok: false, message: `${t9n("save.failed")} (HTTP ${head.status})` };
    }
    const baseHash = (JSON.parse(head.body) as { baseHash: string }).baseHash;

    const next = edit(buildDraft(table), table);
    if (next === null) return { ok: false, message: t9n("relationEdit.constraintGone"), stale: true };

    const meta = draftToMeta(next, table);
    const body: Record<string, unknown> = { ...table };
    if (Object.keys(meta).length > 0) body["meta"] = meta;
    else delete body["meta"];

    const res = await apiPut(wpath(`/tables/${encodeURIComponent(tableId)}`), {
      baseHash,
      force: false,
      table: body,
    });
    if (res.status === 200) {
      const ok = JSON.parse(res.body) as { revision: string };
      rememberRevision(ok.revision);
      // 自分の書き込みは SSE では無視される（INV-3）ため、ここで追随させる。
      // 論理外部制約は index.relations に載る = 再生成しないとエッジが増えない（P §4.3）
      invalidateTable(tableId);
      await loadTable(tableId);
      await reloadIndex(ok.revision);
      return { ok: true };
    }
    if (res.status === 409) return { ok: false, message: t9n("save.staleReload"), stale: true };
    if (res.status === 403) return { ok: false, message: t9n("save.forbidden") };
    if (res.status === 422) {
      const invalid = JSON.parse(res.body) as { errors: { path: string; message: string }[] };
      const detail = invalid.errors.map((e) => `${e.path}: ${e.message}`).join(" / ");
      return { ok: false, message: detail === "" ? t9n("save.failed") : detail };
    }
    return { ok: false, message: `${t9n("save.failed")} (HTTP ${res.status})` };
  } catch {
    return { ok: false, message: `${t9n("save.failed")} (network)` };
  } finally {
    inflight = false;
    void continueFlush();
  }
}

/** エクスポート後などに未保存の有無を判定するヘルパ */
export function hasPending(diagramId?: string): boolean {
  const st = useEditStore.getState();
  if (diagramId !== undefined) return pageOf(st, diagramId).pending.length > 0;
  return st.pendingCount > 0;
}
