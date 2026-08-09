/**
 * テーブル詳細画面 `#/tables/<id>`（O-02）。
 * ER図の詳細ダイアログと同じ TableInfo を使い、同じ解決結果を表示する（P-05）。
 */
import { useI18n } from "../i18n/useI18n";
import { formatName, resolveTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import { NotFound } from "../ui/NotFound";
import { TableInfo } from "../ui/TableInfo";
import { TableDeleteSection } from "./TableDelete";
import styles from "./TableDetail.module.scss";

export function TableDetail({ tableId, notice }: { tableId: string; notice?: string }) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const serverMode = useAppStore((s) => s.serverMode);
  const addToast = useAppStore((s) => s.addToast);

  const it = index?.tables?.find((x) => x.id === tableId);
  if (index !== null && !it) {
    return <NotFound path={`tables/${tableId}`} />;
  }
  const title = it
    ? formatName(resolveTableName(it.name, it.displayName), it.name, nameDisplay)
    : tableId;

  return (
    <div className="catalog-page table-detail-page">
      {notice !== undefined && <div className="notice-banner">{notice}</div>}
      <div className="catalog-header">
        <h2>{title}</h2>
        <span className="mono muted">{tableId}</span>
        {/* 編集開始はヘッダ（EditControls）のペンアイコンに集約 */}
      </div>
      <TableInfo tableId={tableId} />
      {/* 削除（J-02）は本文の下。誤って逆生成したテーブルを個別に消す唯一の導線 */}
      <TableDeleteSection tableId={tableId} />
      {serverMode === true && (
        // 回答C: 新規作成ボタンだけ先行実装（クリック時の挙動 = J-01 は先送り）
        <button
          type="button"
          className={styles.fabNewTable}
          data-testid="new-table"
          title={t("tables.newTable")}
          onClick={() => addToast(t("tables.newTableTodo"))}
        >
          ＋ {t("tables.newTable")}
        </button>
      )}
    </div>
  );
}
