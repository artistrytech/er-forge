/**
 * ページの管理（I-01 追加 / I-02 削除 / I-03 改名・並び替え）。
 *
 * 以前は左パネルを「ページ情報の編集モード」に切り替え、ページ一覧の各行に操作アイコンを
 * 生やしていた。閲覧のための一覧が編集用の見た目に変わるうえ、狭い行に4つのアイコンが並び、
 * どれが何なのか読み取りづらかった。**管理はこのダイアログの中だけで完結させる**。
 *
 * ここでの操作は ER図の配置編集（保存が要る）と違い、**確定した時点でファイルへ書かれる**。
 * その代わりに、改名・削除・追加は行の中で一段確認を挟む（押し間違いで即座に消えないように）。
 * ダイアログを重ねないのは、Esc がどちらを閉じるのか読めなくなるため。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";
import { useAppStore } from "../model/store";
import { cx } from "../lib/cx";
import { AddPageForm } from "./AddPage";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { PenIcon } from "./icons";
import { hrefs } from "./router";
import styles from "./PageManageDialog.module.scss";

/** 行が今どの状態か。同時に開くのは1行だけ（別の行を触ったら畳む） */
type RowMode = { kind: "rename" | "delete"; id: string } | null;

export function PageManageDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const manifest = useAppStore((s) => s.manifest);
  const reorderPage = useEditStore((s) => s.reorderPage);
  const [row, setRow] = useState<RowMode>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diagrams = useMemo(
    () => [...(manifest?.diagrams ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [manifest],
  );

  /** 開くのは常に1か所だけ（改名の途中で削除の確認が並ぶと、どれを確定するのか読めない） */
  const openRow = (next: RowMode): void => {
    setAdding(false);
    setError(null);
    setRow(next);
  };
  const openAdd = (): void => {
    setRow(null);
    setError(null);
    setAdding(true);
  };

  const run = (op: Promise<{ ok: boolean; error?: string }>, after?: () => void): void => {
    void op.then((r) => {
      if (!r.ok) {
        setError(r.error ?? "");
        return;
      }
      setError(null);
      after?.();
    });
  };

  return (
    <Dialog title={t("page.manageTitle")} onClose={onClose}>
      <p className="muted form-hint">{t("page.manageHint")}</p>
      <ul className={styles.list} data-testid="page-manage-list">
        {diagrams.map((d, i) => {
          const title = d.title ?? d.id;
          return (
            <li key={d.id} className={styles.row} data-testid="page-manage-row">
              {row?.kind === "rename" && row.id === d.id ? (
                <RenameRow
                  diagramId={d.id}
                  current={title}
                  onDone={() => setRow(null)}
                  onError={setError}
                />
              ) : row?.kind === "delete" && row.id === d.id ? (
                <DeleteRow
                  diagramId={d.id}
                  title={title}
                  onDone={() => setRow(null)}
                  onError={setError}
                />
              ) : (
                <>
                  <span className={styles.rowName}>{title}</span>
                  <span className={cx("mono", "muted", styles.rowId)}>{d.id}</span>
                  <span className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      title={t("page.moveUp")}
                      disabled={i === 0}
                      onClick={() => run(reorderPage(d.id, "up"))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      title={t("page.moveDown")}
                      disabled={i === diagrams.length - 1}
                      onClick={() => run(reorderPage(d.id, "down"))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      data-testid={`page-rename-${d.id}`}
                      title={t("page.rename")}
                      aria-label={t("page.rename")}
                      onClick={() => openRow({ kind: "rename", id: d.id })}
                    >
                      <PenIcon size={14} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      className={cx(styles.iconButton, styles.trashButton)}
                      data-testid={`page-delete-${d.id}`}
                      title={t("page.delete")}
                      onClick={() => openRow({ kind: "delete", id: d.id })}
                    >
                      🗑
                    </button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {diagrams.length === 0 && <p className="muted">{t("page.manageEmpty")}</p>}

      {/* 追加もこの中で完結させる（ダイアログの上にダイアログを重ねない） */}
      {adding ? (
        <div className={styles.addBox}>
          <AddPageForm
            onCreated={() => {
              setAdding(false);
              onClose(); // 作ったページへ移動するので、管理は閉じてそのページを見せる
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <Button className={styles.addButton} data-testid="page-add" onClick={openAdd}>
          ＋ {t("page.add")}
        </Button>
      )}

      {error !== null && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        <Button data-testid="page-manage-close" onClick={onClose}>
          {t("dialog.close")}
        </Button>
      </div>
    </Dialog>
  );
}

/** 改名（I-03）。行をそのまま入力欄に差し替える */
function RenameRow({
  diagramId,
  current,
  onDone,
  onError,
}: {
  diagramId: string;
  current: string;
  onDone: () => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const renamePage = useEditStore((s) => s.renamePage);
  const [title, setTitle] = useState(current);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.select(), []);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    void renamePage(diagramId, title.trim()).then((r) => {
      onError(r.ok ? null : (r.error ?? ""));
      if (r.ok) onDone();
    });
  };

  return (
    <form className={styles.rowForm} onSubmit={submit}>
      <input
        ref={inputRef}
        type="text"
        className={styles.rowInput}
        data-testid="page-rename-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Button type="submit" variant="primary" data-testid="page-rename-save" disabled={title.trim() === ""}>
        {t("page.rename")}
      </Button>
      <Button onClick={onDone}>{t("layout.cancel")}</Button>
    </form>
  );
}

/** 削除（I-02）。何が失われるかを行の中で示してから消す */
function DeleteRow({
  diagramId,
  title,
  onDone,
  onError,
}: {
  diagramId: string;
  title: string;
  onDone: () => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const deletePage = useEditStore((s) => s.deletePage);
  const addToast = useAppStore((s) => s.addToast);

  const confirm = (): void => {
    void deletePage(diagramId).then((r) => {
      onError(r.ok ? null : (r.error ?? ""));
      if (!r.ok) return;
      onDone();
      addToast(t("page.deleted", { title }));
      // 削除したページを**開いていたときだけ**先頭ページへ戻す（白画面にしない。B-11）。
      // テーブル画面や別ページから消した場合は、今いる画面に留まる
      if (useAppStore.getState().currentDiagramId !== diagramId) return;
      const first = useAppStore.getState().manifest?.diagrams?.[0]?.id;
      location.hash = first !== undefined ? hrefs.erd(first) : hrefs.tables();
    });
  };

  return (
    <div className={styles.rowConfirm}>
      <span className={styles.rowConfirmText}>{t("page.deleteBody", { title })}</span>
      <span className={styles.rowActions}>
        <Button variant="danger" data-testid="page-delete-confirm" onClick={confirm}>
          {t("page.deleteConfirm")}
        </Button>
        <Button onClick={onDone}>{t("layout.cancel")}</Button>
      </span>
    </div>
  );
}
