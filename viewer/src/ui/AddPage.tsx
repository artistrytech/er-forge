/**
 * ページの追加（I-01）。
 *
 * サイドバーの ＋ ボタンと、ページが1枚も無いときの空状態（ErdEmpty）の両方から使う。
 * 逆生成の直後は diagrams が 0 件であり、そこから最初のページを作れることが
 * 「逆生成 → 配置 → コミット」（設計書 §3.4）の入口になる。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";
import { useAppStore } from "../model/store";
import { Dialog } from "./Dialog";
import { hrefs } from "./router";

export function AddPageButton({ className }: { className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className ?? "sidebar-icon-button"}
        data-testid="page-add"
        title={t("page.add")}
        onClick={() => setOpen(true)}
      >
        {className === undefined ? "＋" : t("page.add")}
      </button>
      {open && <AddPageDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * ページが1枚も無いときの入口。ページの作成には編集セッション（＝ロック）が要るため、
 * **閲覧中ならロックを取ってからダイアログを開く**。
 * 「まず編集を開始してください」と突き放すと、ここで行き止まりになる。
 */
export function CreateFirstPageButton() {
  const { t } = useI18n();
  const editing = useEditStore((s) => s.session === "editing");
  const requestStartEditing = useEditStore((s) => s.requestStartEditing);
  const [open, setOpen] = useState(false);
  const [waitingForLock, setWaitingForLock] = useState(false);

  // ロックが取れて編集中になったら、そのままダイアログを開く
  useEffect(() => {
    if (waitingForLock && editing) {
      setWaitingForLock(false);
      setOpen(true);
    }
  }, [waitingForLock, editing]);

  return (
    <>
      <button
        type="button"
        className="header-button-primary"
        data-testid="create-first-page"
        onClick={() => {
          if (editing) {
            setOpen(true);
          } else {
            setWaitingForLock(true);
            requestStartEditing();
          }
        }}
      >
        {t("page.createFirst")}
      </button>
      {open && <AddPageDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function AddPageDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const createPage = useEditStore((s) => s.createPage);
  const addToast = useAppStore((s) => s.addToast);
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    void createPage(id.trim(), title.trim()).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      addToast(t("page.created", { title: title.trim() }));
      onClose();
      location.hash = hrefs.erd(id.trim());
    });
  };

  return (
    <Dialog title={t("page.addTitle")} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="form-row">
          <span>{t("page.id")}</span>
          <input
            autoFocus
            data-testid="page-id"
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="core"
          />
        </label>
        <p className="form-hint">{t("page.idHint")}</p>
        <label className="form-row">
          <span>{t("page.title")}</span>
          <input
            data-testid="page-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="コアドメイン"
          />
        </label>
        {error !== null && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button
            type="submit"
            className="header-button-primary"
            data-testid="page-create"
            disabled={busy || id.trim() === "" || title.trim() === ""}
          >
            {t("page.add")}
          </button>
          <button type="button" onClick={onClose}>
            {t("layout.cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
