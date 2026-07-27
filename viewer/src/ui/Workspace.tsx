/**
 * ワークスペース（マルチデータベース構成の単位）の UI。
 *
 * - タイトル横のプルダウンで切り替え・追加（切り替えはフルリロード）
 * - 追加ダイアログ（welcome 画面とヘッダの [＋] で共用）
 * - 削除ダイアログ（ID の打ち込みを求める。データリセットとは別物）
 * - welcome 画面（ワークスペースが1つも無いとき）
 *
 * 切り替えを**フルリロード**にしているのは、ローダーのキャッシュ・編集状態・キャンバスの
 * 計測値がすべて現在のワークスペースに紐づいているため。部分的な差し替えは必ず取りこぼす。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiDelete, apiPost } from "../model/api";
import { useEditStore } from "../model/editStore";
import { usePageEditStore } from "../model/pageEditStore";
import { queueToastAfterReload, useAppStore } from "../model/store";
import {
  isValidWorkspaceId,
  suggestWorkspaceId,
  type WorkspaceRef,
} from "../model/workspace";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { hrefs } from "./router";
import styles from "./Workspace.module.scss";

/** 未保存の変更（ER図の配置・テーブル編集・カラム論理名編集）があるか */
function hasUnsaved(): boolean {
  const edit = useEditStore.getState();
  const page = usePageEditStore.getState();
  return (edit.session === "editing" && edit.netDirty) || page.controller?.dirty === true;
}

/** 指定ワークスペースを開き直す（URL を書き換えてリロード） */
function openWorkspace(id: string): void {
  location.hash = hrefs.workspace(id);
  location.reload();
}

// ------------------------------------------------------------- プルダウン

/**
 * ヘッダのタイトル（＝現在のワークスペース名）と切替メニュー（一覧 + 末尾に [＋ 追加]）。
 * 単純なリストで、絞り込みは持たない。
 *
 * 名前は**リンクではなくプルダウンのボタンそのもの**にしている。以前は「名前 = ER図へのリンク」
 * ＋「隣の ▾ = 切替」の2つに分かれており、同じ見た目の並びでクリックの意味が食い違っていた。
 * ER図へは共通ヘッダのナビから行ける（ここでの重複を無くす）。
 */
export function WorkspaceMenu({ title, className }: { title: string; className?: string }) {
  const { t } = useI18n();
  const workspaces = useAppStore((s) => s.workspaces);
  const workspaceId = useAppStore((s) => s.workspaceId);
  const serverMode = useAppStore((s) => s.serverMode) === true;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (id: string): void => {
    setOpen(false);
    if (id === workspaceId) return;
    // 未保存があるまま切り替えると失われる（切り替えはリロードのため）
    if (hasUnsaved()) setPendingSwitch(id);
    else openWorkspace(id);
  };

  return (
    <div className={cx(styles.workspaceMenu, className)} ref={ref}>
      <button
        type="button"
        className={cx(styles.workspaceButton, open && styles.open)}
        data-testid="workspace-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("workspace.switch")}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.workspaceTitle} data-testid="app-title">
          {title}
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <div className={styles.workspaceDropdown} role="menu" data-testid="workspace-menu">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitem"
              className={cx(styles.workspaceItem, w.id === workspaceId && styles.current)}
              data-testid="workspace-item"
              data-workspace-id={w.id}
              aria-current={w.id === workspaceId ? "true" : undefined}
              onClick={() => select(w.id)}
            >
              <span className={styles.workspaceItemName}>{w.name}</span>
              <span className={styles.workspaceItemId}>{w.id}</span>
            </button>
          ))}
          {serverMode && (
            <button
              type="button"
              role="menuitem"
              className={styles.workspaceAdd}
              data-testid="workspace-add"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
            >
              ＋ {t("workspace.add")}
            </button>
          )}
        </div>
      )}
      {creating && <WorkspaceCreateDialog onClose={() => setCreating(false)} />}
      {pendingSwitch !== null && (
        <Dialog title={t("workspace.switchConfirm.title")} onClose={() => setPendingSwitch(null)}>
          <p>{t("workspace.switchConfirm.body")}</p>
          <div className="dialog-actions">
            <Button
              variant="primary"
              data-testid="workspace-switch-confirm"
              onClick={() => openWorkspace(pendingSwitch)}
            >
              {t("edit.stopConfirm.discard")}
            </Button>
            <Button onClick={() => setPendingSwitch(null)}>{t("layout.cancel")}</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// --------------------------------------------------------------- 追加

/** ワークスペースの追加。作成直後は空なのでブートストラップ画面に着地する（2段構成） */
export function WorkspaceCreateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const workspaces = useAppStore((s) => s.workspaces);
  const [id, setId] = useState(() => suggestWorkspaceId(workspaces));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const wsId = id.trim();
    const wsName = name.trim();
    if (!isValidWorkspaceId(wsId)) {
      setError(t("workspace.idInvalid"));
      return;
    }
    if (wsName === "") {
      setError(t("workspace.nameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost("/__erd/workspaces", { id: wsId, name: wsName });
      if (res.status === 200) {
        openWorkspace((JSON.parse(res.body) as WorkspaceRef).id);
        return;
      }
      const body = JSON.parse(res.body) as { code?: string; message?: string };
      setError(
        body.code === "DUPLICATE_ID"
          ? t("workspace.duplicate", { id: wsId })
          : (body.message ?? `HTTP ${res.status}`),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("workspace.create.title")} onClose={onClose}>
      <WorkspaceFields
        id={id}
        name={name}
        onId={setId}
        onName={setName}
        onSubmit={() => void submit()}
      />
      {error !== null && <p className={styles.workspaceError}>{error}</p>}
      <div className="dialog-actions">
        <Button
          variant="primary"
          data-testid="workspace-create-submit"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? t("workspace.creating") : t("workspace.create")}
        </Button>
        <Button onClick={onClose}>{t("layout.cancel")}</Button>
      </div>
    </Dialog>
  );
}

/** 追加・welcome で共用する入力欄（ID は省略時 default、名前は必須） */
function WorkspaceFields({
  id,
  name,
  onId,
  onName,
  onSubmit,
}: {
  id: string;
  name: string;
  onId: (v: string) => void;
  onName: (v: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") onSubmit();
  };
  return (
    <div className={styles.workspaceForm}>
      <label className={styles.workspaceField}>
        <span className={styles.workspaceFieldLabel}>{t("workspace.id")}</span>
        <input
          type="text"
          data-testid="workspace-id-input"
          value={id}
          autoFocus
          onChange={(e) => onId(e.target.value)}
          onKeyDown={onKey}
        />
        <span className={styles.workspaceHint}>{t("workspace.idHint")}</span>
      </label>
      <label className={styles.workspaceField}>
        <span className={styles.workspaceFieldLabel}>{t("workspace.name")}</span>
        <input
          type="text"
          data-testid="workspace-name-input"
          placeholder={t("workspace.namePlaceholder")}
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={onKey}
        />
      </label>
    </div>
  );
}

// --------------------------------------------------------------- 削除

/**
 * ワークスペース削除（フォルダごと消す）。データリセットより破壊力が大きいため、
 * **ID の打ち込みが一致するまで実行できない**。未コミットの変更は失われる。
 */
export function WorkspaceDeleteDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceRef;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const addToast = useAppStore((s) => s.addToast);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await apiDelete(`/__erd/workspaces/${encodeURIComponent(workspace.id)}`);
      if (res.status === 200) {
        const body = JSON.parse(res.body) as { workspaces: WorkspaceRef[] };
        const next = body.workspaces[0];
        // 完了通知はリロード後に出す（この直後に画面を読み込み直すため）
        queueToastAfterReload(t("workspace.deleted", { name: workspace.name }));
        // 残りの先頭へ。0件なら welcome 画面に着地する
        location.hash = next !== undefined ? hrefs.workspace(next.id) : "";
        location.reload();
        return;
      }
      addToast(`${t("workspace.deleteFailed")} (HTTP ${res.status})`, "error");
    } catch {
      addToast(t("workspace.deleteFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("workspace.deleteTitle", { name: workspace.name })} onClose={onClose}>
      <p>{t("workspace.deleteBody")}</p>
      <label className={styles.workspaceField}>
        <span className={styles.workspaceFieldLabel}>
          {t("workspace.deleteConfirmHint", { id: workspace.id })}
        </span>
        <input
          type="text"
          data-testid="workspace-delete-input"
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
      <div className="dialog-actions">
        <Button
          variant="danger"
          data-testid="workspace-delete-confirm"
          disabled={busy || typed.trim() !== workspace.id}
          onClick={() => void run()}
        >
          {t("workspace.deleteConfirm")}
        </Button>
        <Button onClick={onClose}>{t("layout.cancel")}</Button>
      </div>
    </Dialog>
  );
}

// --------------------------------------------------------------- welcome

/**
 * ワークスペースが1つも無いときの画面（§10 の1段目）。
 * 作成するとそのワークスペースのブートストラップ画面（サンプル取込 / 逆生成）へ進む。
 */
export function WelcomeScreen() {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const [id, setId] = useState(() => suggestWorkspaceId([]));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const wsId = id.trim();
    const wsName = name.trim();
    if (!isValidWorkspaceId(wsId)) {
      setError(t("workspace.idInvalid"));
      return;
    }
    if (wsName === "") {
      setError(t("workspace.nameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost("/__erd/workspaces", { id: wsId, name: wsName });
      if (res.status === 200) {
        openWorkspace((JSON.parse(res.body) as WorkspaceRef).id);
        return;
      }
      const body = JSON.parse(res.body) as { code?: string; message?: string };
      setError(
        body.code === "DUPLICATE_ID"
          ? t("workspace.duplicate", { id: wsId })
          : (body.message ?? `HTTP ${res.status}`),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 静的モードには作成手段がない（サーバーモードで起動してもらう）
  if (serverMode !== true) {
    return (
      <div className="fatal-screen">
        <div className="fatal-card">
          <h1>{t("app.title")}</h1>
          <p>{t("welcome.staticNoWorkspace")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fatal-screen">
      <div className="fatal-card">
        <h1>{t("app.title")}</h1>
        <p>{t("welcome.lead")}</p>
        <WorkspaceFields
          id={id}
          name={name}
          onId={setId}
          onName={setName}
          onSubmit={() => void submit()}
        />
        {error !== null && <p className={styles.workspaceError}>{error}</p>}
        <p>
          {/* 画面上の主導線なので、ER図 の [最初のページを作成] と同じ見た目に揃える */}
          <Button
            variant="accent"
            data-testid="workspace-create-submit"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? t("workspace.creating") : t("workspace.create")}
          </Button>
        </p>
      </div>
    </div>
  );
}

// --------------------------------------------------------- 見つからない

/** URL が存在しないワークスペースを指していたとき（白画面にせず一覧を出す） */
export function WorkspaceNotFound({ id }: { id: string }) {
  const { t } = useI18n();
  const workspaces = useAppStore((s) => s.workspaces);
  return (
    <div className="fatal-screen">
      <div className="fatal-card">
        <h1>{t("app.title")}</h1>
        <p>{t("workspace.notFound", { id })}</p>
        <div className={styles.workspaceList}>
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              className={styles.workspaceItem}
              data-testid="workspace-item"
              data-workspace-id={w.id}
              onClick={() => openWorkspace(w.id)}
            >
              <span className={styles.workspaceItemName}>{w.name}</span>
              <span className={styles.workspaceItemId}>{w.id}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
