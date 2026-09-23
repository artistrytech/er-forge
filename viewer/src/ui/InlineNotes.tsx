/**
 * 詳細ダイアログ（リレーション / 制約）の中で注記をその場で編集する（R-05）。
 *
 * ダイアログの上にもう1枚ダイアログを重ねず、本文の位置がそのまま入力欄に変わる。
 * 確定＝即時保存（saveTableMeta。読み直し → baseHash → PUT）で、失敗したら入力を残したまま
 * トーストで知らせ、他で書き換えられていた（stale）ときだけ入力を捨てて読み直した内容に戻る。
 *
 * 閲覧専用（canEdit=false）のときは従来どおり本文だけを出し、空なら何も出さない。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { saveTableMeta } from "../model/editStore";
import { writeNotes, type NotesTarget } from "../model/notesTarget";
import { useAppStore } from "../model/store";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { EditPen } from "./TableInfo";
import styles from "./InlineNotes.module.scss";

export function InlineNotes({
  value,
  target,
  canEdit,
  label,
  testId,
  className,
}: {
  /** 今の本文 */
  value: string;
  /** 書く先。canEdit のときだけ使う */
  target: NotesTarget;
  canEdit: boolean;
  /** ペンの aria-label */
  label: string;
  testId: string;
  /** 本文（閲覧時）の追加クラス */
  className?: string;
}) {
  const { t } = useI18n();
  const addToast = useAppStore((s) => s.addToast);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // 開いたら入力欄へ。続きから書けるよう末尾に置く
  useEffect(() => {
    if (!editing) return;
    const el = areaRef.current;
    if (el === null) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const start = (): void => {
    setText(value);
    setEditing(true);
  };
  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await saveTableMeta(target.tableId, (draft) => writeNotes(draft, target, text));
    setBusy(false);
    if (result.ok) {
      addToast(t("doc.notesSaved"));
      setEditing(false);
      return;
    }
    addToast(result.message, "error");
    if (result.stale === true) setEditing(false);
  };

  if (editing) {
    return (
      <div className={styles.editor} data-testid={`${testId}-editor`}>
        <textarea
          ref={areaRef}
          className={styles.area}
          rows={4}
          value={text}
          data-testid={`${testId}-input`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ダイアログの Esc（閉じる）より先に、編集だけをやめる
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
        {/* 確定 / 取消はダイアログの操作と同じ部品（Button）で、見た目をそろえる */}
        <div className={styles.actions}>
          <Button onClick={() => setEditing(false)} disabled={busy}>
            {t("dialog.cancel")}
          </Button>
          <Button
            variant="primary"
            data-testid={`${testId}-apply`}
            disabled={busy}
            onClick={() => void submit()}
          >
            {t("tableEdit.applyEdit")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      {value !== "" ? (
        <span className={cx(styles.text, className)} data-testid={testId}>
          {value}
        </span>
      ) : (
        canEdit && <span className={styles.empty}>{t("doc.noNotes")}</span>
      )}
      {canEdit && <EditPen label={label} testId={`${testId}-edit`} onClick={start} />}
    </div>
  );
}
