/**
 * テーブル / カラムの論理情報（論理名・タグ・色・注記）をその場で編集するダイアログ（R-05）。
 *
 * テーブル画面（詳細 / ドキュメント）のペンと、ER図のテーブル詳細ダイアログのペンから
 * 同じものを開く（ダイアログの積み重ねに載るので、テーブル詳細の上に重なる）。
 * 項目と入力部品はテーブル編集画面（TableEdit の基本情報・カラム行）と同じで、
 * カラムではカラム辞書の共通設定（論理名の辞書値・共通タグ・共通色）も同じ形で見せる。
 *
 * 確定＝即時保存（saveTableMeta。読み直し → baseHash → PUT）。失敗したら入力を残したまま
 * トーストで知らせ、他で書き換えられていた（stale）ときだけ閉じて読み直した内容に戻る。
 * 確定するまでストアには触らない（キャンセルで元どおり）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { isColorToken } from "../model/colors";
import { saveTableMeta } from "../model/editStore";
import {
  readMetaFields,
  writeMetaFields,
  type MetaField,
  type MetaFields,
  type MetaTarget,
} from "../model/metaTarget";
import { useAppStore } from "../model/store";
import type { Table } from "../model/types";
import { Button } from "./Button";
import { ColorSelect } from "./ColorSelect";
import { Dialog } from "./Dialog";
import { TagInput } from "./TagInput";
import styles from "./MetaEditDialog.module.scss";

/**
 * 押されたペンの項目 → 初期フォーカスを当てる入力欄。タグ（TagInput）は入力欄そのものが
 * testId を持ち、色（ColorSelect）はパレットを開くボタンが受け口になる
 */
const FIELD_FOCUS: Record<MetaField, string> = {
  displayName: "#meta-display-name",
  tags: '[data-testid="meta-tags"]',
  color: '[data-testid="meta-color-trigger"]',
  notes: "#meta-notes",
};

export function MetaEditDialog({ target, field }: { target: MetaTarget; field?: MetaField }) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const addToast = useAppStore((s) => s.addToast);
  const index = useAppStore((s) => s.index);
  const dictionary = useAppStore((s) => s.dictionary);
  /**
   * 初期値は開いた時点のテーブルから1回だけ取る。保存の読み直しで一瞬ストアから消えるのを
   * 追随しない（入力欄ごと消えないように）
   */
  const initial = useRef<{ table: Table; fields: MetaFields } | null>(null);
  if (initial.current === null) {
    const table = useAppStore.getState().tables[target.tableId];
    if (table !== undefined) initial.current = { table, fields: readMetaFields(table, target) };
  }
  const [fields, setFields] = useState<MetaFields>(
    () => initial.current?.fields ?? { displayName: "", tags: [], color: "", notes: "" },
  );
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFieldSetElement>(null);

  // Dialog は開いたときに自身へフォーカスする。ここで**押したペンの項目**の入力欄へ移す
  // （項目ごとにペンが並ぶので、論理名のペンから開いてタグに入るのは筋が通らない）
  useEffect(() => {
    const selector = FIELD_FOCUS[field ?? "displayName"];
    formRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [field]);

  // タグ候補（P-12）: index.js の使用中タグ ＋ カラム辞書の共通タグ ＋ いま付いているタグ
  const tagCandidates = useMemo(() => {
    const all = new Set(index?.tagsUsed ?? []);
    for (const entry of Object.values(dictionary?.columns ?? {})) {
      for (const tag of entry.tags ?? []) all.add(tag);
    }
    for (const tag of fields.tags) all.add(tag);
    return [...all].sort((a, b) => a.localeCompare(b, "ja"));
  }, [index, dictionary, fields.tags]);

  const update = (patch: Partial<MetaFields>): void => setFields((f) => ({ ...f, ...patch }));

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await saveTableMeta(target.tableId, (draft) => writeMetaFields(draft, target, fields));
    setBusy(false);
    if (result.ok) {
      addToast(t("doc.metaSaved"));
      closeDialog();
      return;
    }
    addToast(result.message, "error");
    // 他で書き換えられていた: 読み直した内容が正なので、入力は破棄して閉じる
    if (result.stale === true) closeDialog();
  };

  const isColumn = target.kind === "column";
  const title = isColumn ? (
    <>
      {t("doc.columnMetaTitle")}: <span className="mono">{target.column}</span>
    </>
  ) : (
    <>
      {t("doc.tableMetaTitle")}: <span className="mono">{target.tableId}</span>
    </>
  );

  if (initial.current === null) {
    return (
      <Dialog title={title} onClose={closeDialog}>
        <p className="muted">{t("table.loading")}</p>
      </Dialog>
    );
  }

  // カラム辞書の共通設定（カラムのみ）。論理名・色は上書き、タグは合成（消せない）
  const dictEntry = isColumn ? dictionary?.columns?.[target.column] : undefined;
  const dictName = dictEntry?.displayName;
  const commonTags = dictEntry?.tags ?? [];
  const dictColor = dictEntry?.color ?? "";

  return (
    <Dialog title={title} onClose={closeDialog}>
      <p className="muted form-hint">{t("doc.metaHint")}</p>
      <fieldset className={styles.form} disabled={busy} ref={formRef}>
        <div className="form-grid">
          <label htmlFor="meta-display-name">
            {isColumn ? t("table.colLogicalName") : t("tableEdit.displayName")}
          </label>
          <div className={styles.withBadge}>
            <input
              id="meta-display-name"
              type="text"
              value={fields.displayName}
              data-testid="meta-display-name"
              placeholder={dictName !== undefined ? t("tableEdit.dictValue", { value: dictName }) : ""}
              onChange={(e) => update({ displayName: e.target.value })}
            />
            {fields.displayName.trim() !== "" && dictName !== undefined && (
              <span className="badge badge-warn" title={t("tableEdit.dictValue", { value: dictName })}>
                {t("tableEdit.overridesDict")}
              </span>
            )}
          </div>
          <label>{t("tableEdit.tags")}</label>
          <div className={styles.tags}>
            {/* 共通タグは readonly（テーブル編集画面と同じ。個別からは外せない。P-12） */}
            {commonTags.map((tag) => (
              <span key={tag} className="badge badge-dict" title={t("tableEdit.commonTag")}>
                {tag}
              </span>
            ))}
            <TagInput
              value={fields.tags}
              candidates={tagCandidates}
              disabled={busy}
              testId="meta-tags"
              onChange={(tags) => update({ tags })}
            />
          </div>
          {/* 色はタグとは独立した指定（P-13） */}
          <label>{t("tableEdit.color")}</label>
          <div className={styles.withBadge}>
            <ColorSelect
              value={fields.color}
              disabled={busy}
              testId="meta-color"
              onChange={(color) => update({ color })}
            />
            {fields.color === "" && isColorToken(dictColor) && (
              <span className="badge badge-dict" title={t("tableEdit.commonColor")}>
                {t(`color.${dictColor}` as const)}
              </span>
            )}
          </div>
          <label htmlFor="meta-notes" className={styles.notesLabel}>
            {t("tableEdit.notes")}
          </label>
          <textarea
            id="meta-notes"
            className={styles.notes}
            rows={6}
            value={fields.notes}
            data-testid="notes-input"
            onChange={(e) => update({ notes: e.target.value })}
          />
        </div>
      </fieldset>
      <div className="dialog-actions">
        <Button onClick={closeDialog} disabled={busy}>
          {t("dialog.cancel")}
        </Button>
        <Button variant="primary" data-testid="notes-apply" disabled={busy} onClick={() => void submit()}>
          {t("tableEdit.applyEdit")}
        </Button>
      </div>
    </Dialog>
  );
}
