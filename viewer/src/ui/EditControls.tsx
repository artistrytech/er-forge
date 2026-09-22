/**
 * 編集操作（編集開始 / 保存 / 保存して終了 / 編集終了）を画面の右下に浮かせて置く。
 *
 * 以前はヘッダ右端にアイコンだけで畳んでいたが、編集は**いま見ている内容**に対する操作なので
 * 内容の近く（右下）へ出す。ヘッダは移動（ナビ）とアプリ全体の設定だけを持つ。
 * - ER図（editStore）: 閲覧中は丸い [編集] ボタン。編集中は [保存]（サーバー）/
 *   [エクスポート]（静的）＋[保存して終了]＋[編集終了]
 * - カラム辞書（pageEditStore のコントローラ）: 閲覧中は丸い [編集] ボタン。編集中は同じ3つ
 * - テーブル一覧: [編集開始] は画面の中（見出し・左パネルのペン）にあるためここには出さない。
 *   編集中（#/tables/<id>/edit）の保存・終了だけを他の画面と同じ位置に出す
 *
 * 未保存があるまま [編集終了] を押したときだけ確認ダイアログを出す（他の遷移・リロードは対象外）。
 * [保存して終了] は**保存し切れたときだけ**終了する（失敗・衝突なら編集に留まる）。
 *
 * Esc も [編集終了] と同じ扱いにする（N-10）。押した場所によっては別の意味を持つため、
 * 入力中・ダイアログやメニューが開いている間は横取りしない（下の useEffect）。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";
import { usePageEditStore, type PageEditController } from "../model/pageEditStore";
import { useAppStore } from "../model/store";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { PenIcon } from "./icons";
import { Link } from "./Link";
import { hrefs, type Route } from "./router";
import styles from "./EditControls.module.scss";

export function EditControls({ route }: { route: Route }) {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const session = useEditStore((s) => s.session);
  const status = useEditStore((s) => s.status);
  const failMessage = useEditStore((s) => s.failMessage);
  const pendingCount = useEditStore((s) => s.pendingCount);
  // 正味の変更があるか（移動→Undo で相殺されたら false。Undo スタックが尽きた状態）
  const netDirty = useEditStore((s) => s.netDirty);
  const save = useEditStore((s) => s.save);
  const saveAndWait = useEditStore((s) => s.saveAndWait);
  const retry = useEditStore((s) => s.retry);
  const openExport = useEditStore((s) => s.openExport);
  const controller = usePageEditStore((s) => s.controller);
  // ページ管理ダイアログ（追加・改名・並び替え・削除）を開いている間は、ER図・テーブルの
  // 編集を始めさせない。何を編集しているのかが読めなくなるため（相互排他）
  const pageInfoEditing = useAppStore((s) => s.pageInfoEditing);
  // 未保存があるまま終了を押したときに開く確認（保持している関数を実行すると終了する）
  const [pendingEnd, setPendingEnd] = useState<{ run: () => void } | null>(null);

  const requestEnd = (dirty: boolean, end: () => void): void => {
    if (dirty) setPendingEnd({ run: end });
    else end();
  };

  let body: React.ReactNode = null;
  /** Esc で解除できる編集モードの終了処理（無ければ null = いま編集中ではない） */
  let endEdit: (() => void) | null = null;

  if (route.kind === "erd" || route.kind === "erdEdit") {
    // ER図
    const erdId = route.diagramId;
    if (erdId !== undefined) {
      const editing = session === "editing";
      if (!editing) {
        body = <StartEditFab href={hrefs.erdEdit(erdId)} locked={pageInfoEditing} />;
      } else {
        const end = (): void => {
          location.hash = hrefs.erd(erdId);
        };
        endEdit = () => requestEnd(netDirty, end);
        body = (
          <>
            {serverMode === true && (
              <>
                <SaveButton
                  status={status}
                  title={saveTitle(t, status, failMessage, pendingCount)}
                  disabled={status === "saved" || status === "saving"}
                  onClick={() => (status === "failed" ? retry() : save())}
                />
                <SaveAndEndButton
                  disabled={status === "saving"}
                  onClick={() => {
                    void (async () => {
                      // 保存するものが無ければそのまま終了する（空の書き込みを送らない）
                      if (!netDirty || (await saveAndWait())) end();
                    })();
                  }}
                />
              </>
            )}
            {/* 静的モードは保存先が無い。動作モードの常設表示を information に畳んだため、
                「保存されない」ことだけは編集中に出し続ける（A-02） */}
            {serverMode === false && (
              <>
                <span className={styles.staticWarning} data-testid="static-warning">
                  {t("session.notSaved")}
                </span>
                <ActionButton
                  data-testid="export-button"
                  title={t("edit.exportButton")}
                  onClick={() => openExport(erdId)}
                  icon={<ExportIcon />}
                  label={t("edit.exportButton")}
                />
              </>
            )}
            <EndEditButton onClick={() => requestEnd(netDirty, end)} />
          </>
        );
      }
    }
  } else if (route.kind === "tableEdit" || route.kind === "columnsEdit") {
    // テーブル編集 / カラム辞書の編集。サーバーモードのみ（静的モードは App が閲覧へ逃がす）
    if (serverMode === true && controller) {
      endEdit = () => requestEnd(controller.dirty, controller.end);
      body = <PageEditButtons controller={controller} onEnd={requestEnd} />;
    }
  } else if (route.kind === "columns") {
    if (serverMode === true) body = <StartEditFab href={hrefs.columnsEdit()} />;
  }

  return (
    <>
      <EscapeToEndEdit endEdit={endEdit} />
      {body !== null && (
        <div className={styles.dock} data-testid="edit-dock">
          {body}
        </div>
      )}
      {pendingEnd !== null && (
        <Dialog title={t("edit.stopConfirm.title")} onClose={() => setPendingEnd(null)}>
          <p>{t("session.endConfirmBody")}</p>
          <div className="dialog-actions">
            <Button
              variant="primary"
              data-testid="end-confirm-discard"
              onClick={() => {
                const run = pendingEnd.run;
                setPendingEnd(null);
                run();
              }}
            >
              {t("edit.stopConfirm.discard")}
            </Button>
            <Button onClick={() => setPendingEnd(null)}>{t("layout.cancel")}</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/**
 * 入力中か（Esc をこちらで横取りしてよいかの判定）。
 * IME の変換中（isComposing）も入力中として扱う — 変換の取り消しに Esc が要る。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

/**
 * Esc で編集モードを解除する（[編集終了] と同じ経路なので、未保存があれば確認が出る）。
 *
 * Esc は押した文脈で意味が変わるキーなので、**ほかに Esc を待っているものが無いときだけ**
 * 横取りする:
 * - 入力欄・IME の変換中（{@link isTypingTarget}）… 入力側のもの
 * - ダイアログ・メニューが開いている … そちらを閉じるためのもの。どちらも window の keydown を
 *   見ており、後から登録されるぶん**こちらの方が先に呼ばれる**ので、DOM の有無で判定する
 * - 色・注記のポップオーバーは capture 段階で握り潰すため、そもそもここへ届かない
 */
function EscapeToEndEdit({ endEdit }: { endEdit: (() => void) | null }) {
  const endRef = useRef(endEdit);
  useEffect(() => {
    endRef.current = endEdit;
  }, [endEdit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      // ページ管理もダイアログなので、この分岐でそちらに譲る（Dialog 自身が Esc で閉じる）
      if (document.querySelector('[role="dialog"], [role="menu"]') !== null) return;
      endRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}

/** テーブル編集 / カラム辞書編集の [保存]＋[保存して終了]＋[編集終了]（pageEditStore 由来） */
function PageEditButtons({
  controller,
  onEnd,
}: {
  controller: PageEditController;
  onEnd: (dirty: boolean, end: () => void) => void;
}) {
  const { t } = useI18n();
  const { dirty, saving, canSave } = controller;
  const status: SaveStatusKind = saving ? "saving" : dirty ? "dirty" : "saved";
  return (
    <>
      <SaveButton
        status={status}
        title={saving ? t("save.saving") : t("save.button")}
        disabled={!dirty || saving || !canSave}
        onClick={() => void controller.save()}
      />
      <SaveAndEndButton
        disabled={saving || !canSave}
        onClick={() => {
          void (async () => {
            // 保存するものが無ければそのまま終了する（空の書き込みを送らない）
            if (!dirty || (await controller.save())) controller.end();
          })();
        }}
      />
      <EndEditButton onClick={() => onEnd(dirty, controller.end)} />
    </>
  );
}

type SaveStatusKind = "saved" | "dirty" | "saving" | "failed";

function saveTitle(
  t: ReturnType<typeof useI18n>["t"],
  status: SaveStatusKind,
  failMessage: string | null,
  pendingCount: number,
): string {
  if (status === "failed") {
    return `${t("save.failed")}${failMessage !== null ? ` (${failMessage})` : ""} — ${t("save.retry")}`;
  }
  if (status === "saving") return t("save.saving");
  if (status === "dirty") return `${t("save.button")} (${t("save.unsaved", { n: pendingCount })})`;
  return t("save.saved");
}

/** 右下に並ぶボタンの共通形（アイコン＋ラベル）。アイコンだけにしないのは、
    ヘッダから離れて文脈が薄くなったぶん、何が起きるかを文字で示すため */
function ActionButton({
  icon,
  label,
  variant = "default",
  ...rest
}: {
  icon: React.ReactNode;
  label: string;
  variant?: "default" | "primary" | "danger";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(styles.action, variant === "primary" && styles.primary, variant === "danger" && styles.danger)}
      {...rest}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SaveButton({
  status,
  title,
  disabled,
  onClick,
}: {
  status: SaveStatusKind;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <ActionButton
      variant={status === "failed" ? "danger" : "primary"}
      data-testid="save-button"
      data-status={status}
      title={title}
      disabled={disabled}
      onClick={onClick}
      icon={<SaveIcon />}
      label={status === "failed" ? t("save.retry") : t("save.button")}
    />
  );
}

/** 保存して、保存し切れたらそのまま編集を終了する（アイコンは [保存] と同じ） */
function SaveAndEndButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <ActionButton
      data-testid="save-end-button"
      title={t("edit.stopConfirm.save")}
      disabled={disabled}
      onClick={onClick}
      icon={<SaveIcon />}
      label={t("edit.stopConfirm.save")}
    />
  );
}

/** 閲覧中に出る丸い [編集]（ER図・カラム辞書）。locked = ページ管理ダイアログを開いている */
function StartEditFab({ href, locked = false }: { href: string; locked?: boolean }) {
  const { t } = useI18n();
  if (locked) {
    return (
      <button
        type="button"
        className={styles.fab}
        data-testid="session-toggle"
        data-editing="false"
        disabled
        title={t("session.lockedByPageEdit")}
        aria-label={t("session.startEdit")}
      >
        <PenIcon size={22} />
      </button>
    );
  }
  return (
    <Link
      className={styles.fab}
      data-testid="session-toggle"
      data-editing="false"
      href={href}
      title={t("session.startEdit")}
      aria-label={t("session.startEdit")}
    >
      <PenIcon size={22} />
    </Link>
  );
}

function EndEditButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <ActionButton
      data-testid="session-toggle"
      data-editing="true"
      title={t("session.endEdit")}
      onClick={onClick}
      icon={<CloseIcon />}
      label={t("session.endEdit")}
    />
  );
}

// ---------------------------------------------------------------- アイコン（インライン SVG）

function SaveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
