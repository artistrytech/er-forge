/**
 * インクリメンタルローダー（設計書 §6）。
 *
 * モードにかかわらず、データの読み込みは常に <script> タグによる
 * workspace-<id>/data/**.js の動的注入で行う（§4.3。API はデータ取得に使わない）。
 *
 * 段階0: ワークスペース一覧（workspaces.js）→ 段階1: manifest → 段階2: index + dictionary
 * → 段階3: 表示対象ページ（オンデマンド）→ 段階4: 選択テーブルのスキーマ（オンデマンド）
 * → 段階5: 残り全テーブル（アイドル時）
 */
import { apiToken } from "./api";
import { useAppStore } from "./store";
import {
  SUPPORTED_SCHEMA_VERSION,
  zConfig,
  zDiagram,
  zDictionary,
  zIndexData,
  zManifest,
  zTable,
  zWorkspaces,
  type Diagram,
  type Table,
} from "./types";
import { workspaceIdFromHash } from "../ui/router";
import {
  dataBase,
  setCurrentWorkspaceId,
  type WorkspaceRef,
} from "./workspace";

const REGISTRY_FILE = "workspaces.js";

/** データファイルが呼ぶグローバル API の受け皿（設計書 §5.2） */
interface Staged {
  workspaces: unknown;
  manifest: unknown;
  config: unknown;
  index: unknown;
  dictionary: unknown;
  tables: Map<string, unknown>;
  diagrams: Map<string, unknown>;
}

const staged: Staged = {
  workspaces: undefined,
  manifest: undefined,
  config: undefined,
  index: undefined,
  dictionary: undefined,
  tables: new Map(),
  diagrams: new Map(),
};

export function installGlobalApi(): void {
  const g = globalThis as Record<string, unknown>;
  g["ERD"] = {
    workspaces: (o: unknown) => {
      staged.workspaces = o;
    },
    manifest: (o: unknown) => {
      staged.manifest = o;
    },
    config: (o: unknown) => {
      staged.config = o;
    },
    index: (o: unknown) => {
      staged.index = o;
    },
    dictionary: (o: unknown) => {
      staged.dictionary = o;
    },
    table: (o: unknown) => {
      const id = (o as { id?: unknown } | null)?.id;
      if (typeof id === "string") staged.tables.set(id, o);
    },
    diagram: (o: unknown) => {
      const id = (o as { id?: unknown } | null)?.id;
      if (typeof id === "string") staged.diagrams.set(id, o);
    },
  };
}

/**
 * データファイルの URL にトークンを足す（§8.5）。
 *
 * データファイルは `ERD.tables({...})` を呼ぶスクリプトなので、配信にトークンを要求しないと
 * **利用者が開いた任意の Web ページが `<script src>` で読み出せてしまう**（`<script>` は CORS で
 * 止まらない）。ヘッダを付けられない読み込み方（§4.3）なので、クエリで渡す。
 *
 * `file://`（静的モード）にはトークンの概念が無いため何も足さない。読み込み経路は1本のまま。
 */
function withToken(src: string): string {
  const token = apiToken();
  if (token === "" || (location.protocol !== "http:" && location.protocol !== "https:")) return src;
  return `${src}${src.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
}

/**
 * 読み込みに失敗した理由がトークン不一致（403）かどうか。
 * `<script>` の onerror はステータスを教えてくれないため、同じ URL を XHR で引き直して確かめる。
 * 失敗したときにしか呼ばないので、正常時のコストはゼロ。
 */
function isForbidden(src: string): Promise<boolean> {
  if (location.protocol !== "http:" && location.protocol !== "https:") return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", withToken(src), true);
      xhr.timeout = 3000;
      xhr.onload = () => resolve(xhr.status === 403);
      xhr.onerror = () => resolve(false);
      xhr.ontimeout = () => resolve(false);
      xhr.send();
    } catch {
      resolve(false);
    }
  });
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = withToken(src);
    el.async = true;
    el.onload = () => {
      el.remove();
      resolve();
    };
    el.onerror = () => {
      el.remove();
      reject(new Error(`failed to load ${src}`));
    };
    document.head.appendChild(el);
  });
}

/**
 * /__erd/health のボディからサーバーのリリースバージョンを取り出す（A-02）。
 * 古いサーバーは appVersion を返さないため、無ければ null にして表示を落とす。
 */
function serverVersionOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const v = (parsed as { appVersion?: unknown }).appVersion;
      if (typeof v === "string" && v !== "") return v;
    }
  } catch {
    // ボディが JSON でなくてもモード判定（疎通）には影響させない
  }
  return null;
}

/** モード判定（A-01）: /__erd/health の疎通。file:// では即座に静的モード */
function detectMode(): void {
  const set = (serverMode: boolean) => useAppStore.setState({ serverMode });
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    set(false);
    return;
  }
  // §2.3 によりビューア本体では fetch を使わない（XHR は可）
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/__erd/health", true);
    xhr.timeout = 3000;
    xhr.onload = () => {
      set(xhr.status === 200);
      if (xhr.status === 200) useAppStore.setState({ serverVersion: serverVersionOf(xhr.responseText) });
    };
    xhr.onerror = () => set(false);
    xhr.ontimeout = () => set(false);
    xhr.send();
  } catch {
    set(false);
  }
}

/**
 * 段階0: ワークスペース一覧（`workspaces.js`）。
 *
 * file:// ではディレクトリを走査できないため、このファイルだけが一覧の情報源になる
 * （サーバーモードではサーバーが走査結果で再生成してから配信する）。
 * 無い・壊れている場合は空一覧として扱い、welcome 画面へ落とす。
 */
async function loadWorkspaces(): Promise<WorkspaceRef[]> {
  try {
    await injectScript(REGISTRY_FILE);
  } catch {
    return [];
  }
  const raw = staged.workspaces;
  staged.workspaces = undefined;
  const parsed = zWorkspaces.safeParse(raw);
  return parsed.success ? parsed.data.workspaces : [];
}

/**
 * 表示するワークスペースを決める: URL（`#/w/<id>`）→ 最後に見たもの → 先頭。
 * URL が存在しない ID を指していた場合は null を返し、呼び出し側が「見つかりません」を出す。
 */
function resolveWorkspace(workspaces: WorkspaceRef[]): WorkspaceRef | null {
  const fromHash = workspaceIdFromHash(location.hash);
  if (fromHash !== null) {
    return workspaces.find((w) => w.id === fromHash) ?? null;
  }
  const last = useAppStore.getState().lastWorkspaceId;
  return (
    (last !== null ? workspaces.find((w) => w.id === last) : undefined) ?? workspaces[0] ?? null
  );
}

/** URL にワークスペースが入っていなければ補う（履歴を汚さない） */
function canonicalizeHash(workspaceId: string): void {
  if (workspaceIdFromHash(location.hash) === workspaceId) return;
  const rest = location.hash.replace(/^#/, "").replace(/^\//, "");
  location.replace(`#/w/${encodeURIComponent(workspaceId)}${rest === "" ? "" : `/${rest}`}`);
}

/** 起動シーケンス。main.tsx から1回だけ呼ぶ */
export async function boot(): Promise<void> {
  installGlobalApi();
  detectMode();
  const set = useAppStore.setState;

  // 段階0: ワークスペース（どのデータを読むかがこれで決まる）
  const workspaces = await loadWorkspaces();
  set({ workspaces });
  if (workspaces.length === 0) {
    // トークンが違うと配信そのものが 403 になる（§8.5）。「まだ何も無い（welcome）」と
    // 区別しないと、初回起動と取り違えて延々ワークスペースを作らせることになる
    set({ fatal: (await isForbidden(REGISTRY_FILE)) ? { kind: "forbidden" } : { kind: "no-workspace" } });
    return;
  }
  const current = resolveWorkspace(workspaces);
  if (current === null) {
    set({ fatal: { kind: "workspace-not-found", id: workspaceIdFromHash(location.hash) ?? "" } });
    return;
  }
  setCurrentWorkspaceId(current.id);
  useAppStore.getState().setWorkspace(current.id);
  canonicalizeHash(current.id);

  // 段階1: manifest
  try {
    await injectScript(dataBase() + "manifest.js");
  } catch {
    set({
      fatal: (await isForbidden(dataBase() + "manifest.js"))
        ? { kind: "forbidden" }
        : { kind: "no-data" },
    });
    return;
  }
  const rawManifest = staged.manifest;
  staged.manifest = undefined;
  const pm = zManifest.safeParse(rawManifest);
  if (rawManifest === undefined || !pm.success) {
    set({ fatal: { kind: "bad-data", file: "manifest.js" } });
    return;
  }
  const manifest = pm.data;

  // バージョン検証（A-04）: 不一致なら描画せずバナーのみ
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    const kind = manifest.schemaVersion > SUPPORTED_SCHEMA_VERSION ? "data-newer" : "data-older";
    set({ manifest, fatal: { kind, version: manifest.schemaVersion } });
    return;
  }
  set({ manifest });

  if (Object.keys(manifest.tables ?? {}).length === 0) {
    set({ fatal: { kind: "empty" } });
    return;
  }

  // 段階2: index + dictionary（config はサーバーモード専用のため読まない。§6.1）
  const loadIndex = injectScript(dataBase() + "index.js").then(() => {
    const raw = staged.index;
    staged.index = undefined;
    const parsed = zIndexData.safeParse(raw);
    if (raw === undefined || !parsed.success) throw new Error("index.js");
    useAppStore.setState({ index: parsed.data });
  });
  const dictFile = manifest.dictionary ?? "dictionary.js";
  const loadDict = injectScript(dataBase() + dictFile)
    .then(() => {
      const raw = staged.dictionary;
      staged.dictionary = undefined;
      const parsed = zDictionary.safeParse(raw);
      useAppStore.setState({
        dictionary: raw !== undefined && parsed.success ? parsed.data : { columns: {} },
      });
    })
    .catch(() => {
      // 辞書の欠損は閲覧を止めない（物理名フォールバックで表示できる）
      useAppStore.setState({ dictionary: { columns: {} } });
    });

  try {
    // config.js は閲覧に不要なので読まない（無視リストは逆生成の画面で遅延ロードする。§6.1）
    await Promise.all([loadIndex, loadDict]);
  } catch {
    set({ fatal: { kind: "bad-data", file: "index.js" } });
    return;
  }

  set({ ready: true });

  // 段階5: 残り全テーブルをアイドル時にバックグラウンドで読む
  scheduleBackgroundLoad();
}

/** 書き込み後・外部変更後の再読込はリビジョンをクエリに付けてキャッシュを回避する（§4.3） */
function withVersion(src: string, v?: string): string {
  return v === undefined ? src : `${src}?v=${encodeURIComponent(v)}`;
}

// ---- 段階3: ダイアグラム（オンデマンド） ----

const inflightDiagrams = new Map<string, Promise<Diagram | null>>();

export function loadDiagram(id: string, version?: string): Promise<Diagram | null> {
  const st = useAppStore.getState();
  const cached = st.diagrams[id];
  if (cached) return Promise.resolve(cached);
  const existing = inflightDiagrams.get(id);
  if (existing) return existing;

  const ref = st.manifest?.diagrams?.find((d) => d.id === id);
  if (!ref) {
    return Promise.resolve(null);
  }
  const p = injectScript(withVersion(dataBase() + ref.file, version))
    .then(() => {
      const raw = staged.diagrams.get(id);
      staged.diagrams.delete(id);
      const parsed = zDiagram.safeParse(raw);
      if (raw === undefined || !parsed.success) throw new Error(ref.file);
      useAppStore.setState((s) => ({ diagrams: { ...s.diagrams, [id]: parsed.data } }));
      return parsed.data;
    })
    .catch((e: unknown) => {
      useAppStore.setState((s) => ({
        diagramErrors: { ...s.diagramErrors, [id]: e instanceof Error ? e.message : String(e) },
      }));
      return null;
    })
    .finally(() => {
      inflightDiagrams.delete(id);
    });
  inflightDiagrams.set(id, p);
  return p;
}

/** 外部変更の取り込み（H-09）: キャッシュを捨ててから読み直す */
export function forceReloadDiagram(id: string, version?: string): Promise<Diagram | null> {
  useAppStore.setState((s) => {
    const diagrams = { ...s.diagrams };
    delete diagrams[id];
    const diagramErrors = { ...s.diagramErrors };
    delete diagramErrors[id];
    return { diagrams, diagramErrors };
  });
  return loadDiagram(id, version);
}

/** index.js の再読込（スキーマ・配置の外部変更でノード名・リレーション・所属ページを追随させる） */
export async function reloadIndex(version?: string): Promise<void> {
  try {
    await injectScript(withVersion(dataBase() + "index.js", version));
    const raw = staged.index;
    staged.index = undefined;
    const parsed = zIndexData.safeParse(raw);
    if (raw !== undefined && parsed.success) {
      useAppStore.setState({ index: parsed.data });
    }
  } catch {
    // 失敗時は手元の index を維持する（次の変更イベントで再試行される）
  }
}

export async function reloadDictionary(version?: string): Promise<void> {
  const dictFile = useAppStore.getState().manifest?.dictionary ?? "dictionary.js";
  try {
    await injectScript(withVersion(dataBase() + dictFile, version));
    const raw = staged.dictionary;
    staged.dictionary = undefined;
    const parsed = zDictionary.safeParse(raw);
    if (raw !== undefined && parsed.success) {
      useAppStore.setState({ dictionary: parsed.data });
    }
  } catch {
    // 失敗時は手元の辞書を維持する
  }
}

/**
 * config.js（テーブル無視リスト。§6.1 段階2'）。
 * 閲覧には不要なため静的モードでは読まない。逆生成の画面を開いたときに遅延ロードする。
 */
export async function loadConfig(version?: string): Promise<void> {
  const file = useAppStore.getState().manifest?.config ?? "config.js";
  try {
    await injectScript(withVersion(dataBase() + file, version));
    const raw = staged.config;
    staged.config = undefined;
    const parsed = zConfig.safeParse(raw);
    useAppStore.setState({
      config: raw !== undefined && parsed.success ? parsed.data : { ignoreTables: [] },
    });
  } catch {
    // config.js は無くてよい（無視リストが空のプロジェクト）
    useAppStore.setState({ config: { ignoreTables: [] } });
  }
}

/**
 * 逆生成の適用後（K-11）: 何が変わったかを追わず、派生物と全テーブルを読み直す。
 * スキーマ・manifest・index が一度に変わるため、部分的な追随はかえって漏れる。
 */
export async function reloadAfterApply(revision: string): Promise<void> {
  await reloadManifest(revision);
  await Promise.all([reloadIndex(revision), reloadDictionary(revision), loadConfig(revision)]);

  const state = useAppStore.getState();
  for (const id of Object.keys(state.tables)) {
    invalidateTable(id);
  }
  for (const id of Object.keys(state.tableErrors)) {
    invalidateTable(id);
  }
  await Promise.all(
    Object.keys(state.diagrams).map((id) => forceReloadDiagram(id, revision)),
  );
  scheduleBackgroundLoad();
}

export async function reloadManifest(version?: string): Promise<void> {
  try {
    await injectScript(withVersion(dataBase() + "manifest.js", version));
    const raw = staged.manifest;
    staged.manifest = undefined;
    const parsed = zManifest.safeParse(raw);
    if (raw !== undefined && parsed.success) {
      useAppStore.setState({ manifest: parsed.data });
      // テーブルが増えていることがある（外部での追加・逆生成の適用）。増えた分を読みに行かないと
      // 「読み込み済み < 全体」のまま進捗が完了しない
      scheduleBackgroundLoad();
    }
  } catch {
    // 失敗時は手元の manifest を維持する
  }
}

/**
 * スキーマファイルの外部変更でキャッシュを無効化する（読み直させる）。
 *
 * 捨てるだけだと「読み込み済み < 全体」の状態が残り、ヘッダの進捗バーが完了しない。
 * 段階5 のバックグラウンドロードを再点火して、手元の内容を最新に追随させる。
 */
export function invalidateTable(id: string): void {
  useAppStore.setState((s) => {
    const tables = { ...s.tables };
    const hadTable = tables[id] !== undefined;
    delete tables[id];
    const tableErrors = { ...s.tableErrors };
    const hadError = tableErrors[id] !== undefined;
    delete tableErrors[id];
    return {
      tables,
      tableErrors,
      loadedTableCount: s.loadedTableCount - (hadTable ? 1 : 0),
      failedTableCount: s.failedTableCount - (hadError ? 1 : 0),
    };
  });
  scheduleBackgroundLoad();
}

// ---- 段階4/5: テーブルスキーマ ----

const inflightTables = new Map<string, Promise<Table | null>>();

export function loadTable(id: string): Promise<Table | null> {
  const st = useAppStore.getState();
  const cached = st.tables[id];
  if (cached) return Promise.resolve(cached);
  if (st.tableErrors[id] !== undefined) return Promise.resolve(null);
  const existing = inflightTables.get(id);
  if (existing) return existing;

  const path = st.manifest?.tables?.[id];
  if (path === undefined) {
    markTableError(id, "not in manifest");
    return Promise.resolve(null);
  }
  const p = injectScript(dataBase() + path)
    .then(() => {
      const raw = staged.tables.get(id);
      staged.tables.delete(id);
      if (raw === undefined) throw new Error("no payload");
      const parsed = zTable.safeParse(raw);
      if (!parsed.success) throw new Error("invalid data");
      useAppStore.setState((s) => ({
        tables: { ...s.tables, [id]: parsed.data },
        loadedTableCount: s.loadedTableCount + 1,
      }));
      return parsed.data;
    })
    .catch((e: unknown) => {
      markTableError(id, e instanceof Error ? e.message : String(e));
      return null;
    })
    .finally(() => {
      inflightTables.delete(id);
    });
  inflightTables.set(id, p);
  return p;
}

function markTableError(id: string, error: string): void {
  useAppStore.setState((s) => ({
    tableErrors: { ...s.tableErrors, [id]: error },
    failedTableCount: s.failedTableCount + 1,
  }));
}

/**
 * 全テーブルが揃うまで待つ（スキーマ JSON の書き出し）。
 *
 * 段階5 のバックグラウンドロードは**アイドル待ち**なので、書き出しの時点で終わっている保証がない。
 * ここでは待たずに詰めて読む。`loadTable` が済んだもの・実行中のものを共有するため、
 * 二重読み込みにはならない。読めなかったテーブル（`tableErrors`）はここでは再試行せず、
 * 呼び出し側が「書き出せなかったもの」として扱う。
 */
export async function loadAllTables(): Promise<void> {
  const manifest = useAppStore.getState().manifest;
  if (!manifest) return;
  const ids = Object.keys(manifest.tables ?? {});
  const MAX_PARALLEL = 8;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      await loadTable(ids[next++]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, ids.length) }, worker));
}

/** まだ手元に無いテーブル（manifest にあって、読み込み済みでも失敗済みでもないもの） */
function pendingTableIds(): string[] {
  const st = useAppStore.getState();
  return Object.keys(st.manifest?.tables ?? {}).filter(
    (id) =>
      st.tables[id] === undefined &&
      st.tableErrors[id] === undefined &&
      !inflightTables.has(id),
  );
}

/** 二重に走らせない（走行中の呼び出しは、その回の巡回が拾う） */
let backgroundLoading = false;

/**
 * 段階5: アイドル時のバックグラウンドロード（§6.2）。
 * requestIdleCallback（未対応環境は setTimeout）でチャンク実行し、並列度 8 に制限する。
 *
 * **対象は呼び出しごとに取り直す**（起動時の一覧を握り続けない）。外部変更でテーブルが
 * 増えたり、無効化で未読に戻ったりするため、固定の一覧だと取りこぼしが残り、
 * ヘッダの進捗バーが 100% 手前で完了しなくなる。何度呼んでも安全。
 */
export function scheduleBackgroundLoad(): void {
  if (backgroundLoading) return;
  const st = useAppStore.getState();
  if (!st.manifest) return;
  backgroundLoading = true;

  let queue: string[] = [];
  let active = 0;
  const MAX_PARALLEL = 8;

  const idle = (fn: () => void): void => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === "function") {
      // timeout 付きで呼ぶ。重い画面（大きな ER図）ではアイドルが来ず、
      // 指定しないと読み込みが途中で止まったまま進まなくなる
      w.requestIdleCallback(fn, { timeout: 500 });
    } else {
      setTimeout(fn, 16);
    }
  };

  const pump = (): void => {
    while (active < MAX_PARALLEL) {
      if (queue.length === 0) queue = pendingTableIds();
      const id = queue.shift();
      if (id === undefined) break; // 未読なし
      active++;
      void loadTable(id).finally(() => {
        active--;
        idle(pump);
      });
    }
    if (active === 0 && queue.length === 0) backgroundLoading = false;
  };
  idle(pump);
}
