/**
 * ER図の編集状態（H-01〜H-13 / 詳細設計 H01-H13_layout-edit-sync-undo.md）。
 *
 * 3層の状態モデル（§1.1）:
 * - committed: サーバー上のファイルと一致していると信じている状態（このモジュールの Map）
 * - pending:   まだ書かれていないコマンド列（store の pages[*].pending）
 * - view:      committed + pending。appStore.diagrams に反映し、描画側は常にこれを読む
 *
 * 不変条件: INV-1 変更を黙って捨てない / INV-2 スナップは入力時 / INV-3 自リビジョン無視 /
 * INV-4 編集はコマンド経由 / INV-5 baseHash 不一致で書かない / INV-6 書き込みは直列。
 */
import { create } from "zustand";
import { translate, type MsgKey } from "../i18n/messages";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, apiToken } from "./api";
import { applyCommands, foldToPayload, invert, type Command } from "./commands";
import {
  forceReloadDiagram,
  invalidateTable,
  reloadDictionary,
  reloadIndex,
  reloadManifest,
} from "./loader";
import { useAppStore } from "./store";
import type { Diagram } from "./types";

export type SaveStatus = "saved" | "dirty" | "saving" | "failed";

export type EditDialog =
  | { type: "staticWarn" }
  | { type: "lockBusy"; lastHeartbeat?: string }
  | { type: "stopConfirm" }
  | { type: "conflict"; diagramId: string }
  | { type: "lockLost" };

/** ページ管理（I-01〜I-03）の結果。エラーは呼び出し元がフォームに表示する */
export type PageOpResult = { ok: true } | { ok: false; error: string };

export interface PageEdit {
  pending: Command[];
  undo: Command[];
  redo: Command[];
}

const EMPTY_PAGE: PageEdit = { pending: [], undo: [], redo: [] };

interface EditState {
  session: "viewing" | "editing";
  saveMode: "auto" | "manual";
  status: SaveStatus;
  failMessage: string | null;
  pages: Record<string, PageEdit>;
  pendingCount: number;
  dialog: EditDialog | null;
  /** 現在ページが外部で更新された（未保存ありのため自動反映しない）バナー（H-09） */
  externalUpdate: { diagramId: string; revision: string } | null;
  exportDiagramId: string | null;

  requestStartEditing(): void;
  confirmStartEditing(force: boolean): void;
  requestStopEditing(): void;
  stopEditing(action: "save" | "discard" | "cancel"): void;
  closeDialog(): void;
  setSaveMode(mode: "auto" | "manual"): void;

  push(diagramId: string, cmd: Command): void;
  undo(diagramId: string): void;
  redo(diagramId: string): void;

  save(): void;
  retry(): void;
  resolveConflict(action: "overwrite" | "reload"): void;
  resolveExternal(action: "overwrite" | "reload"): void;

  openExport(diagramId: string): void;
  closeExport(): void;
  setDragging(dragging: boolean): void;

  /** ページ管理（I-01〜I-03）。編集ロックを共有し、書き込みは保存経路と直列化する */
  createPage(id: string, title: string): Promise<PageOpResult>;
  renamePage(diagramId: string, title: string): Promise<PageOpResult>;
  reorderPage(diagramId: string, direction: "up" | "down"): Promise<PageOpResult>;
  deletePage(diagramId: string): Promise<PageOpResult>;
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

let lockId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimerStartedAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
let inflight = false;
let queuedFlush = false;
let stopAfterSave = false;
let dragging = false;

const AUTO_SAVE_DEBOUNCE_MS = 300;
const AUTO_SAVE_MAX_WAIT_MS = 2000;
const HEARTBEAT_MS = 15_000;
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

function serverMode(): boolean {
  return useAppStore.getState().serverMode === true;
}

function toast(text: string): void {
  useAppStore.getState().addToast(text);
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
  saveMode: "auto",
  status: "saved",
  failMessage: null,
  pages: {},
  pendingCount: 0,
  dialog: null,
  externalUpdate: null,
  exportDiagramId: null,

  // ---- 編集セッション（H-10 / §2） ----

  requestStartEditing: () => {
    if (get().session === "editing") return;
    if (!serverMode()) {
      set({ dialog: { type: "staticWarn" } });
      return;
    }
    void acquireLock(false);
  },

  confirmStartEditing: (force) => {
    if (!serverMode()) {
      // 静的モード: 警告を了解した。保存はできない（H-13 のエクスポートで持ち出す）
      set({ session: "editing", dialog: null });
      return;
    }
    void acquireLock(force);
  },

  requestStopEditing: () => {
    const st = get();
    if (st.session !== "editing") return;
    if (serverMode() && st.pendingCount > 0) {
      set({ dialog: { type: "stopConfirm" } });
      return;
    }
    get().stopEditing("discard");
  },

  stopEditing: (action) => {
    if (action === "cancel") {
      set({ dialog: null });
      return;
    }
    if (action === "save") {
      stopAfterSave = true;
      set({ dialog: null });
      void flush();
      return;
    }
    // discard: 未保存の変更を捨てて committed に戻す（静的モードでは pending は無いか、
    // あっても保存手段が無いため view を保ったまま閲覧に戻る）
    const st = get();
    if (serverMode()) {
      const pages: Record<string, PageEdit> = {};
      for (const [id, page] of Object.entries(st.pages)) {
        if (page.pending.length > 0) {
          const base = committed.get(id);
          if (base) setView(id, base);
          pages[id] = { pending: [], undo: [], redo: [] };
        } else {
          pages[id] = page;
        }
      }
      set({ pages, pendingCount: 0 });
    }
    endSession();
  },

  closeDialog: () => set({ dialog: null }),

  setSaveMode: (saveMode) => {
    set({ saveMode });
    if (saveMode === "auto") scheduleAutoSave();
  },

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
    set({ pages, pendingCount: countPending(pages), status: statusAfterEdit(st.status) });
    scheduleAutoSave();
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
    set({ pages, pendingCount: countPending(pages), status: statusAfterEdit(st.status) });
    scheduleAutoSave();
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
    set({ pages, pendingCount: countPending(pages), status: statusAfterEdit(st.status) });
    scheduleAutoSave();
  },

  // ---- 保存（H-03 / H-04 / §4） ----

  save: () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
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
    if (action === "overwrite") {
      void overwriteAndSync(ext.diagramId);
    } else {
      void discardAndReload(ext.diagramId, ext.revision);
    }
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
    pageOp(() => apiPost("/__erd/diagrams", { lockId, id, title })),

  renamePage: (diagramId, title) =>
    pageOp(() =>
      apiPatch(`/__erd/diagrams/${encodeURIComponent(diagramId)}`, {
        lockId,
        baseHash: baseHashes.get(`diagrams/${diagramId}.js`) ?? "",
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

    return pageOp(() =>
      apiPatch(`/__erd/diagrams/${encodeURIComponent(self.id)}`, {
        lockId,
        baseHash: baseHashes.get(`diagrams/${self.id}.js`) ?? "",
        order: a,
      }),
    ).then((first) =>
      !first.ok
        ? first
        : pageOp(() =>
            apiPatch(`/__erd/diagrams/${encodeURIComponent(other.id)}`, {
              lockId,
              baseHash: baseHashes.get(`diagrams/${other.id}.js`) ?? "",
              order: b,
            }),
          ),
    );
  },

  deletePage: (diagramId) =>
    pageOp(
      () =>
        apiDelete(`/__erd/diagrams/${encodeURIComponent(diagramId)}`, {
          lockId,
          baseHash: baseHashes.get(`diagrams/${diagramId}.js`) ?? "",
        }),
      diagramId,
    ),
}));

/**
 * ページ管理の書き込み（I-01〜I-03）。レイアウトの保存（flush）と同じ1本の経路に載せる
 * （INV-6。並行して投げると、後から届いた古い index.js が新しいものを上書きしうる）。
 *
 * 成功後は manifest / index を読み直す。ページの追加・削除・改名はいずれも派生ファイルを
 * 動かすため、何が変わったかを判定せず、まとめて追随させる（§8.2 と同じ方針）。
 */
async function pageOp(
  request: () => Promise<{ status: number; body: string }>,
  removedDiagramId?: string,
): Promise<PageOpResult> {
  if (!serverMode() || lockId === null) {
    return { ok: false, error: t9n("page.editHint") };
  }
  await waitForIdle();
  inflight = true;
  try {
    const res = await request();
    if (res.status === 200) {
      const body = JSON.parse(res.body) as { revision: string };
      rememberRevision(body.revision);
      if (removedDiagramId !== undefined) forgetDiagram(removedDiagramId);
      await Promise.all([reloadManifest(body.revision), reloadIndex(body.revision)]);
      await refreshHashes();
      return { ok: true };
    }
    if (res.status === 423) {
      onLockLost();
      return { ok: false, error: t9n("edit.lockLost.title") };
    }
    const body = JSON.parse(res.body) as { code?: string; id?: string; message?: string };
    if (body.code === "DUPLICATE_ID") {
      return { ok: false, error: t9n("page.duplicateId", { id: body.id ?? "" }) };
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
 * ELK による自動レイアウト（H-07 / H-08）。書き込みをしないためロックは不要。
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

// ------------------------------------------------------------- 編集ロック（H-11）

async function acquireLock(force: boolean): Promise<void> {
  try {
    const res = await apiPost("/__erd/lock", force ? { force: true } : {});
    if (res.status === 200) {
      const body = JSON.parse(res.body) as { lockId: string };
      lockId = body.lockId;
      startHeartbeat();
      await refreshHashes();
      useEditStore.setState({ session: "editing", dialog: null, status: "saved", failMessage: null });
      return;
    }
    if (res.status === 423) {
      const body = JSON.parse(res.body) as { lastHeartbeat?: string };
      useEditStore.setState({ dialog: { type: "lockBusy", lastHeartbeat: body.lastHeartbeat } });
      return;
    }
    toast(`lock error: HTTP ${res.status}`);
  } catch {
    toast("lock error: network");
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (lockId === null) return;
    apiPut("/__erd/lock", { lockId }).then(
      (res) => {
        if (res.status === 409) onLockLost();
      },
      () => {
        // サーバー不達は保存経路のエラーで扱う（heartbeat では何もしない）
      },
    );
  }, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** ロック喪失（強制取得された / 失効）: 閲覧中へ強制降格。未保存の変更は保持する（INV-1） */
function onLockLost(): void {
  stopHeartbeat();
  lockId = null;
  stopAfterSave = false;
  useEditStore.setState({ session: "viewing", dialog: { type: "lockLost" } });
}

function endSession(): void {
  const id = lockId;
  stopHeartbeat();
  lockId = null;
  stopAfterSave = false;
  if (id !== null) {
    void apiDelete("/__erd/lock", { lockId: id }).catch(() => undefined);
  }
  useEditStore.setState({ session: "viewing", dialog: null, status: "saved", failMessage: null });
}

// ------------------------------------------------------------------ 保存エンジン

function scheduleAutoSave(): void {
  const st = useEditStore.getState();
  if (!serverMode() || st.saveMode !== "auto" || st.session !== "editing") return;
  if (st.pendingCount === 0) return;
  const now = Date.now();
  if (saveTimer === null) {
    saveTimerStartedAt = now;
  } else {
    clearTimeout(saveTimer);
    // debounce しすぎない（maxWait 2000ms）
    if (now - saveTimerStartedAt >= AUTO_SAVE_MAX_WAIT_MS) {
      saveTimer = null;
      void flush();
      return;
    }
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flush();
  }, AUTO_SAVE_DEBOUNCE_MS);
}

/**
 * 書き込みは常に1本だけ（INV-6）。pending のあるページを順に1ページずつ送る。
 * forceFor を指定したページは baseHash の検証をスキップして上書き保存する（§4.3）。
 */
async function flush(forceFor?: string): Promise<void> {
  if (inflight) {
    queuedFlush = true;
    return;
  }
  if (!serverMode() || lockId === null) return;
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
    const res = await apiPatch(`/__erd/diagrams/${diagramId}`, {
      lockId,
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
    } else if (res.status === 423) {
      restorePending(diagramId, sent);
      useEditStore.setState({ status: "failed", failMessage: null });
      onLockLost();
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
  if (st.pendingCount === 0) {
    useEditStore.setState({ status: "saved", failMessage: null });
    if (stopAfterSave) {
      stopAfterSave = false;
      endSession();
    }
  } else {
    useEditStore.setState({ status: "dirty" });
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
  eventSource = new EventSource(`/__erd/events?t=${encodeURIComponent(apiToken())}`);
  eventSource.addEventListener("change", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data as string) as {
        revision: string;
        files: string[];
      };
      handleChangeEvent(data);
    } catch {
      // 壊れたイベントは無視する
    }
  });
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
    const st = useEditStore.getState();
    const page = pageOf(st, currentId);
    const busy = page.pending.length > 0 || inflight || st.status === "failed";
    if (st.session === "editing" && busy) {
      // 未保存あり: 自動で何もしない。バナーで選ばせる（INV-1）
      useEditStore.setState({ externalUpdate: { diagramId: currentId, revision: ev.revision } });
    } else {
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
  const hadStacks = stacksNotEmpty(diagramId);
  committed.delete(diagramId);
  clearStacks(diagramId);
  await forceReloadDiagram(diagramId, revision);
  await refreshHashes();
  toast(t9n(hadStacks ? "toast.undoCleared" : "toast.externalApplied"));
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
  useEditStore.setState((s) => ({
    status: s.pendingCount > 0 ? "dirty" : "saved",
    failMessage: null,
  }));
  toast(t9n("toast.undoCleared"));
}

function stacksNotEmpty(diagramId: string): boolean {
  const page = pageOf(useEditStore.getState(), diagramId);
  return page.pending.length > 0 || page.undo.length > 0 || page.redo.length > 0;
}

function clearStacks(diagramId: string): void {
  useEditStore.setState((s) => {
    const pages = { ...s.pages, [diagramId]: { pending: [], undo: [], redo: [] } };
    return { pages, pendingCount: countPending(pages) };
  });
}

async function refreshHashes(): Promise<void> {
  try {
    const res = await apiGet("/__erd/project");
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
  window.addEventListener("pagehide", () => {
    if (lockId !== null) {
      // sendBeacon は POST しか送れないため専用エンドポイントを使う
      navigator.sendBeacon(
        `/__erd/lock/release?t=${encodeURIComponent(apiToken())}`,
        JSON.stringify({ lockId }),
      );
    }
  });
  window.addEventListener("beforeunload", (e) => {
    const st = useEditStore.getState();
    // 静的モードでは警告しない（保存手段がないため。§8.1）
    if (serverMode() && st.session === "editing" && st.pendingCount > 0) {
      e.preventDefault();
    }
  });
}

// ---------------------------------------- 他画面（テーブル編集・一括編集）との共有

/**
 * 編集フォーム（O-03 / P-03）の書き込みが使う編集ロックID。
 * ロックはプロジェクト全体で1つ（H-11）であり、フォームも同じセッションを共有する。
 */
export function currentLockId(): string | null {
  return lockId;
}

/** フォームの保存が発行したリビジョンを記録し、SSE のエコーバックを無視させる（INV-3） */
export function rememberOwnRevision(revision: string): void {
  rememberRevision(revision);
}

/** フォームの保存が 423 LOCK_LOST を受けたときの共通処理（閲覧へ強制降格） */
export function notifyLockLost(): void {
  onLockLost();
}

/** エクスポート後などに未保存の有無を判定するヘルパ */
export function hasPending(diagramId?: string): boolean {
  const st = useEditStore.getState();
  if (diagramId !== undefined) return pageOf(st, diagramId).pending.length > 0;
  return st.pendingCount > 0;
}
