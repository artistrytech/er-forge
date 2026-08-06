/**
 * カラム1件の詳細ダイアログ（P-03）。
 *
 * 一覧の [🔍] から開く。以前は「出現」「個別設定」を列として持っていたが、数字だけでは
 * **どのテーブルが該当するのか**が分からず、列幅も食っていた。一覧は共通設定の編集に徹し、
 * 内訳はここで見せる。
 *
 * 編集モード中はテーブルへのリンクを非活性にする（未保存の編集を残したまま遷移させない）。
 */
import { useI18n } from "../i18n/useI18n";
import { cx } from "../lib/cx";
import { colorAttr } from "../model/colors";
import type { ColumnRow, DictionaryDraft } from "../model/columnDictionary";
import { formatName, resolveIndexTableName } from "../model/logicalName";
import { totalTableCount, useAppStore } from "../model/store";
import type { IndexTable } from "../model/types";
import { ColorSelect } from "../ui/ColorSelect";
import { Dialog } from "../ui/Dialog";
import { TagInput } from "../ui/TagInput";
import { hrefs } from "../ui/router";
import styles from "./ColumnDetailDialog.module.scss";

export function ColumnDetailDialog({
  row,
  draft,
  canEdit,
  tagCandidates,
  onChange,
  onClose,
}: {
  row: ColumnRow;
  draft: DictionaryDraft;
  /** 編集ルートかつサーバーモード。false なら閲覧専用（リンクは活きる） */
  canEdit: boolean;
  tagCandidates: readonly string[];
  onChange: (patch: Partial<DictionaryDraft>) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const total = useAppStore((s) => totalTableCount(s));
  const allLoaded = loaded + failed >= total;

  const byId = new Map<string, IndexTable>((index?.tables ?? []).map((it) => [it.id, it]));
  const label = (tableId: string): string => {
    const it = byId.get(tableId);
    return it === undefined ? tableId : formatName(resolveIndexTableName(it), it.name, nameDisplay);
  };

  /** 編集中はリンクを出さない（遷移させない）。テキストは同じものを残す */
  const TableLink = ({ tableId }: { tableId: string }) =>
    canEdit ? (
      <span className={styles.linkDisabled} title={t("columnsPage.linkDisabled")}>
        {label(tableId)}
      </span>
    ) : (
      <a href={hrefs.table(tableId)} onClick={onClose}>
        {label(tableId)}
      </a>
    );

  return (
    <Dialog title={<span className="mono">{row.name}</span>} onClose={onClose} size="wide">
      {/* ---- 共通設定（この画面で編集する値） ---- */}
      <h3 className={styles.heading}>{t("columnsPage.detail.common")}</h3>
      <dl className={styles.grid}>
        <dt>{t("columnsPage.colLogical")}</dt>
        <dd>
          {canEdit ? (
            <input
              type="text"
              value={draft.displayName}
              data-testid="detail-display-name"
              placeholder={`（${t("table.notSet")}）`}
              onChange={(e) => onChange({ displayName: e.target.value })}
            />
          ) : (
            <span className={draft.displayName === "" ? "muted" : ""}>
              {draft.displayName === "" ? `（${t("table.notSet")}）` : draft.displayName}
            </span>
          )}
        </dd>
        <dt>{t("table.tags")}</dt>
        <dd>
          {canEdit ? (
            <TagInput
              value={draft.tags}
              candidates={tagCandidates}
              testId="detail-tags"
              onChange={(tags) => onChange({ tags })}
            />
          ) : draft.tags.length === 0 ? (
            <span className="muted">（{t("table.notSet")}）</span>
          ) : (
            draft.tags.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))
          )}
          <p className="muted form-hint">{t("columnsPage.detail.tagsHint")}</p>
        </dd>
        <dt>{t("tableEdit.color")}</dt>
        <dd>
          {canEdit ? (
            <ColorSelect
              value={draft.color}
              testId="detail-color"
              onChange={(color) => onChange({ color })}
            />
          ) : draft.color === "" ? (
            <span className="muted">（{t("table.notSet")}）</span>
          ) : (
            <span className={styles.swatch} data-color={colorAttr(draft.color)} />
          )}
          <p className="muted form-hint">{t("columnsPage.detail.colorHint")}</p>
        </dd>
      </dl>

      {/* ---- 出現テーブル ---- */}
      <h3 className={styles.heading}>
        {t("columnsPage.detail.occurrences", { n: row.occurrences })}
      </h3>
      {!allLoaded && (
        <p className="notice-banner">
          {t("columnsPage.detail.partial", { loaded: loaded + failed, total })}
        </p>
      )}
      {row.occurrences === 0 ? (
        <p className={styles.orphan} data-testid="detail-orphan">
          {t("columnsPage.orphanReason")}
        </p>
      ) : (
        <ul className={styles.tableList} data-testid="detail-occurrences">
          {row.occurrenceTables.map((id) => (
            <li key={id}>
              <TableLink tableId={id} />
            </li>
          ))}
        </ul>
      )}

      {/* ---- 個別設定（テーブル側で上書き・追加されているもの） ---- */}
      <h3 className={styles.heading}>
        {t("columnsPage.detail.overrides", { n: row.overrides.length })}
      </h3>
      {row.overrides.length === 0 ? (
        <p className="muted">{t("columnsPage.detail.noOverrides")}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="detail-overrides">
            <thead>
              <tr>
                <th>{t("catalog.colTable")}</th>
                <th>{t("columnsPage.colLogical")}</th>
                <th>{t("table.tags")}</th>
                <th>{t("tableEdit.color")}</th>
              </tr>
            </thead>
            <tbody>
              {row.overrides.map((o) => (
                <tr key={o.tableId}>
                  <td>
                    <TableLink tableId={o.tableId} />
                  </td>
                  <td>
                    {o.displayName === undefined ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        {o.displayName}
                        <span className="badge badge-warn" title={t("columnsPage.detail.overridesDict")}>
                          {t("tableEdit.overridesDict")}
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    {o.tags.length === 0
                      ? "—"
                      : o.tags.map((tag) => (
                          <span key={tag} className={cx(styles.tag, styles.tagOwn)}>
                            {tag}
                          </span>
                        ))}
                  </td>
                  <td>
                    {o.color === undefined ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className={styles.swatch} data-color={colorAttr(o.color)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {t("dialog.close")}
        </button>
      </div>
    </Dialog>
  );
}
