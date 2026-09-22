/**
 * ノードのダブルクリックで開くテーブル詳細ダイアログ（D-06 / G-01〜G-07）。
 * 一時的な UI であり URL を持たない。テーブル詳細画面への実リンクを提供する（G-06）。
 *
 * サーバーモードでは、テーブル画面と同じく論理情報（論理名・タグ・色・注記）を
 * ペンからその場編集できる（R-05）。制約・リレーションの詳細はこの上に重なって開く。
 */
import { useI18n } from "../i18n/useI18n";
import { formatName, resolveTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import { Dialog } from "./Dialog";
import { Link } from "./Link";
import { hrefs } from "./router";
import { TableInfo } from "./TableInfo";

export function TableDetailDialog({ tableId }: { tableId: string }) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const closeAllDialogs = useAppStore((s) => s.closeAllDialogs);
  const serverMode = useAppStore((s) => s.serverMode === true);
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);

  const it = index?.tables?.find((x) => x.id === tableId);
  const title = it
    ? formatName(resolveTableName(it.name, it.displayName), it.name, nameDisplay)
    : tableId;

  return (
    <Dialog title={title} onClose={closeDialog} size="full">
      {/* 別の画面へ移るときは、下に重なっているダイアログも含めて全部閉じる */}
      <p className="dialog-detail-link">
        <Link className="button-link" href={hrefs.table(tableId)} onClick={closeAllDialogs}>
          {t("table.openDetail")}
        </Link>
        {serverMode && <span className="muted"> — {t("table.editHere")}</span>}
      </p>
      <TableInfo tableId={tableId} onNavigate={closeAllDialogs} canEdit={serverMode} />
    </Dialog>
  );
}
