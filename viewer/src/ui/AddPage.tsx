/**
 * ページの追加（I-01）。
 *
 * ページ管理ダイアログ（{@link PageManageDialog}）の中の追加フォームと、ページが1枚も
 * 無いときの空状態（ErdEmpty）の両方から使う。逆生成の直後は diagrams が 0 件であり、
 * そこから最初のページを作れることが「逆生成 → 配置 → コミット」（設計書 §3.4）の入口になる。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";
import { useAppStore } from "../model/store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { hrefs } from "./router";

/**
 * ページが1枚も無いときの入口。編集ロックは無く、ページ作成はサーバーモードなら
 * いつでもできる（§2.3）。そのままダイアログを開く。
 */
export function CreateFirstPageButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="accent" data-testid="create-first-page" onClick={() => setOpen(true)}>
        {t("page.createFirst")}
      </Button>
      {open && <AddPageDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function AddPageDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog title={t("page.addTitle")} onClose={onClose}>
      <AddPageForm onCreated={onClose} onCancel={onClose} />
    </Dialog>
  );
}

/**
 * ページID・ページ名の入力（作成まで）。**ダイアログの枠は含まない** — ページ管理
 * ダイアログの中では枠を重ねずにその場で開くため（ダイアログの上のダイアログにしない）。
 *
 * 作成できたら通知を出し、そのページへ移動する（作った直後に配置を始められるように）。
 */
export function AddPageForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const createPage = useEditStore((s) => s.createPage);
  const addToast = useAppStore((s) => s.addToast);
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idRef = useRef<HTMLInputElement>(null);

  // 開いた直後からページID を打てるようにする。Dialog の data-autofocus は枠が現れた1回
  // きりなので、途中で開くフォーム（ページ管理ダイアログの中）では自分で当てる
  useEffect(() => idRef.current?.focus(), []);

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
      onCreated();
      location.hash = hrefs.erd(id.trim());
    });
  };

  return (
    <form onSubmit={submit}>
      <label className="form-row">
        <span>{t("page.id")}</span>
        <input
          ref={idRef}
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
        <Button
          type="submit"
          variant="primary"
          data-testid="page-create"
          disabled={busy || id.trim() === "" || title.trim() === ""}
        >
          {t("page.add")}
        </Button>
        <Button onClick={onCancel}>{t("layout.cancel")}</Button>
      </div>
    </form>
  );
}
