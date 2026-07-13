/**
 * インクリメンタルローダー（設計書 §6）。
 *
 * モードにかかわらず、データの読み込みは常に <script> タグによる
 * data/**.js の動的注入で行う（§4.3。API はデータ取得に使わない）。
 *
 * 段階1: manifest → 段階2: index + dictionary → 段階3: 表示対象ページ（オンデマンド）
 * → 段階4: 選択テーブルのスキーマ（オンデマンド）→ 段階5: 残り全テーブル（アイドル時）
 */
import { useAppStore } from "./store";
import {
  SUPPORTED_SCHEMA_VERSION,
  zDiagram,
  zDictionary,
  zIndexData,
  zManifest,
  zTable,
  type Diagram,
  type Table,
} from "./types";

const DATA_BASE = "data/";

/** データファイルが呼ぶグローバル API の受け皿（設計書 §5.2） */
interface Staged {
  manifest: unknown;
  config: unknown;
  index: unknown;
  dictionary: unknown;
  tables: Map<string, unknown>;
  diagrams: Map<string, unknown>;
}

const staged: Staged = {
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

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
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
    xhr.onload = () => set(xhr.status === 200);
    xhr.onerror = () => set(false);
    xhr.ontimeout = () => set(false);
    xhr.send();
  } catch {
    set(false);
  }
}

/** 起動シーケンス。main.tsx から1回だけ呼ぶ */
export async function boot(): Promise<void> {
  installGlobalApi();
  detectMode();
  const set = useAppStore.setState;

  // 段階1: manifest
  try {
    await injectScript(DATA_BASE + "manifest.js");
  } catch {
    set({ fatal: { kind: "no-data" } });
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
  const loadIndex = injectScript(DATA_BASE + "index.js").then(() => {
    const raw = staged.index;
    staged.index = undefined;
    const parsed = zIndexData.safeParse(raw);
    if (raw === undefined || !parsed.success) throw new Error("index.js");
    useAppStore.setState({ index: parsed.data });
  });
  const dictFile = manifest.dictionary ?? "dictionary.js";
  const loadDict = injectScript(DATA_BASE + dictFile)
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
  const p = injectScript(withVersion(DATA_BASE + ref.file, version))
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
    await injectScript(withVersion(DATA_BASE + "index.js", version));
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
    await injectScript(withVersion(DATA_BASE + dictFile, version));
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

export async function reloadManifest(version?: string): Promise<void> {
  try {
    await injectScript(withVersion(DATA_BASE + "manifest.js", version));
    const raw = staged.manifest;
    staged.manifest = undefined;
    const parsed = zManifest.safeParse(raw);
    if (raw !== undefined && parsed.success) {
      useAppStore.setState({ manifest: parsed.data });
    }
  } catch {
    // 失敗時は手元の manifest を維持する
  }
}

/** スキーマファイルの外部変更でキャッシュを無効化する（次に開いたとき読み直す） */
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
  const p = injectScript(DATA_BASE + path)
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
 * 段階5: アイドル時のバックグラウンドロード（§6.2）。
 * requestIdleCallback（未対応環境は setTimeout）でチャンク実行し、並列度 8 に制限する。
 */
export function scheduleBackgroundLoad(): void {
  const manifest = useAppStore.getState().manifest;
  if (!manifest) return;
  const ids = Object.keys(manifest.tables ?? {});
  let next = 0;
  let active = 0;
  const MAX_PARALLEL = 8;

  const idle = (fn: () => void): void => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(fn);
    } else {
      setTimeout(fn, 16);
    }
  };

  const pump = (): void => {
    while (active < MAX_PARALLEL && next < ids.length) {
      const id = ids[next++]!;
      active++;
      void loadTable(id).finally(() => {
        active--;
        idle(pump);
      });
    }
  };
  idle(pump);
}
