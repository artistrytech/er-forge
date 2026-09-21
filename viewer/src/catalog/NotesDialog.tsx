/**
 * カラム注記の編集（P-04）。一覧の行から開くマルチライン入力のモーダル。
 *
 * 行内の 1行 input だと、注記に何が書いてあるか読めず、改行も入れられない。
 * 一覧には「注記があること」だけを残し（NotesCell）、本文の読み書きはここで行う。
 *
 * 確定するまで親の draft は触らない（キャンセルで元に戻せるように）。
 *
 * ドキュメントモード（R-05）からはテーブル注記・カラム注記の**即時保存**にも使う。
 * そちらは onSubmit が非同期で、保存中は busy で確定ボタンを止め、失敗時は開いたままにする。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";
import { cx } from "../lib/cx";
import { Dialog } from "../ui/Dialog";
import styles from "./NotesDialog.module.scss";

export function NotesDialog({
  columnName,
  value,
  onSubmit,
  onClose,
  title,
  busy = false,
}: {
  columnName: string;
  value: string;
  onSubmit: (next: string) => void;
  onClose: () => void;
  /** 見出し（既定は「注記: <カラム名>」） */
  title?: ReactNode;
  /** 保存中（確定ボタンを止める） */
  busy?: boolean;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Dialog は開いたときに自身へフォーカスする（その効果はこの effect より先に走る）。
  // autoFocus では上書きされてしまうので、ここで入力欄へ移し、続きから書けるよう末尾に置く
  useEffect(() => {
    const el = areaRef.current;
    if (el === null) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <Dialog
      title={
        title ?? (
          <>
            {t("table.colNotes")}: <span className="mono">{columnName}</span>
          </>
        )
      }
      onClose={onClose}
    >
      <p className="muted form-hint">{t("tableEdit.notesDialogHint")}</p>
      <textarea
        ref={areaRef}
        className={styles.area}
        rows={10}
        value={text}
        data-testid="notes-input"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {t("dialog.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          data-testid="notes-apply"
          disabled={busy}
          onClick={() => onSubmit(text)}
        >
          {t("tableEdit.applyEdit")}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * 一覧の注記セル。未入力なら追加の導線、入力済みなら 1行分の抜粋を出す。
 * 抜粋は 1行に潰す（改行を含む注記で行の高さが変わらないように）。
 */
export function NotesCell({
  value,
  columnName,
  onOpen,
}: {
  value: string;
  columnName: string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const filled = value.trim() !== "";
  return (
    <button
      type="button"
      className={cx(styles.cellButton, !filled && styles.empty)}
      title={filled ? value : t("tableEdit.notesAdd")}
      data-testid={`column-notes-${columnName}`}
      onClick={onOpen}
    >
      {filled ? value.replace(/\s+/g, " ") : t("tableEdit.notesAdd")}
    </button>
  );
}
