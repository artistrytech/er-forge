/**
 * テーブルの削除（J-02 / O-03 詳細設計 §6.2）。テーブル画面上部のバー（読んでいる位置の
 * テーブル）のごみ箱から開く（詳細・ドキュメントのどちらでも）。
 *
 * 削除するのは基本的に**スキーマファイルだけ**である。
 * - ER図のノードを一緒に消すかは選べる（既定は消す。外すと孤児ノードとして残る。K-13）
 * - このテーブルを参照していた他テーブルの FK は書き換えない（他テーブルを勝手に触らない）
 *
 * どちらも「気づかないうちに消えた」を避けるための設計なので、削除の前に影響を提示する。
 * 影響は index.js（配置ページ・被参照）と読み込み済みのテーブル（失われる meta）から
 * 組み立てる。API はデータを返さない（§4.3）ため、サーバーには問い合わせない。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiGet, wpath } from "../model/api";
import { useEditStore } from "../model/editStore";
import { useAppStore } from "../model/store";
import { Dialog } from "../ui/Dialog";
import { TrashIcon } from "../ui/icons";
import { hrefs } from "../ui/router";
import styles from "./TableDelete.module.scss";

/** バーに置く削除の導線（ごみ箱）。サーバーモードでのみ現れる（静的モードは閲覧専用） */
export function TableDeleteButton({ tableId }: { tableId: string }) {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const [confirming, setConfirming] = useState(false);

  if (serverMode !== true) return null;
  return (
    <>
      <button
        type="button"
        className={styles.deleteButton}
        data-testid="delete-table"
        title={t("tableDelete.button")}
        aria-label={t("tableDelete.button")}
        onClick={() => setConfirming(true)}
      >
        <TrashIcon size={16} strokeWidth={2} />
      </button>
      {confirming && (
        <TableDeleteDialog tableId={tableId} onClose={() => setConfirming(false)} />
      )}
    </>
  );
}

function TableDeleteDialog({ tableId, onClose }: { tableId: string; onClose: () => void }) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const manifest = useAppStore((s) => s.manifest);
  const table = useAppStore((s) => s.tables[tableId]);
  const addToast = useAppStore((s) => s.addToast);
  const deleteTable = useEditStore((s) => s.deleteTable);

  /**
   * 確認を出す**直前**のハッシュを取り、これで削除する（INV-5）。
   * 確認している間に外部で書き換えられたら 409 で止まる（見ていない内容のまま消さない）。
   */
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * 配置されているノードも消すか。既定は ON — 削除したテーブルのノードを残したい場面は
   * 稀で、⚠ の付いた孤児ノードが各ページに残る方が困る。「自動削除しない」（K-13）は
   * *黙って*消さないという意味であり、ここでは選んだうえで消す
   */
  const [removeNodes, setRemoveNodes] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiGet(wpath(`/tables/${encodeURIComponent(tableId)}`));
        if (cancelled) return;
        if (res.status === 200) {
          setBaseHash((JSON.parse(res.body) as { baseHash: string }).baseHash);
        } else {
          // 403 はトークン不一致（§8.5）。「見つかりません」と混ぜると原因に辿り着けない
          setError(res.status === 403 ? t("save.forbidden") : `${t("save.failed")} (HTTP ${res.status})`);
        }
      } catch {
        if (!cancelled) setError(`${t("save.failed")} (network)`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tableId, t]);

  const placedOn = (index?.tables?.find((x) => x.id === tableId)?.diagrams ?? []).map(
    (id) => manifest?.diagrams?.find((d) => d.id === id)?.title ?? id,
  );
  // 同じテーブルから複数の制約で参照されていることがあるので、テーブル単位に畳む
  const referencedBy = [
    ...new Set(
      (index?.relations ?? [])
        .filter((r) => r.to === tableId && r.from !== tableId)
        .map((r) => r.from),
    ),
  ];
  const meta = table?.meta;
  const logicalCount =
    (meta?.logicalUniques?.length ?? 0) + (meta?.logicalForeignKeys?.length ?? 0);
  const losesMeta =
    (meta?.displayName ?? "") !== "" ||
    (meta?.notes ?? "") !== "" ||
    (meta?.tags?.length ?? 0) > 0 ||
    Object.keys(meta?.columns ?? {}).length > 0 ||
    logicalCount > 0;

  const onDelete = async (): Promise<void> => {
    if (baseHash === null || deleting) return;
    setDeleting(true);
    setError(null);
    const result = await deleteTable(tableId, baseHash, removeNodes && placedOn.length > 0);
    if (!result.ok) {
      setDeleting(false);
      setError(result.error);
      return;
    }
    addToast(t("tableDelete.done", { id: tableId }));
    onClose();
    // 削除した詳細画面に留まると「見つかりません」になるため、一覧へ戻す
    location.hash = hrefs.tables();
  };

  return (
    <Dialog title={t("tableDelete.title")} onClose={onClose}>
      <p>
        {t("tableDelete.body")} <span className="mono">{tableId}</span>
      </p>
      <ul className={styles.impactList} data-testid="delete-impact">
        {placedOn.length > 0 && (
          <li>
            {removeNodes
              ? t("tableDelete.warnPagesRemoved", {
                  n: placedOn.length,
                  pages: placedOn.join(", "),
                })
              : t("tableDelete.warnPages", { n: placedOn.length, pages: placedOn.join(", ") })}
          </li>
        )}
        {referencedBy.length > 0 && (
          <li>
            {t("tableDelete.warnReferenced", {
              n: referencedBy.length,
              tables: referencedBy.join(", "),
            })}
          </li>
        )}
        {losesMeta && <li>{t("tableDelete.warnMeta")}</li>}
        <li>{t("tableDelete.warnFile", { file: manifest?.tables?.[tableId] ?? "" })}</li>
      </ul>
      {/* ノードを消すかは選べる（配置されているときだけ問う） */}
      {placedOn.length > 0 && (
        <label className={styles.removeNodes}>
          <input
            type="checkbox"
            data-testid="delete-remove-nodes"
            checked={removeNodes}
            disabled={deleting}
            onChange={(e) => setRemoveNodes(e.target.checked)}
          />
          {t("tableDelete.removeNodes")}
        </label>
      )}
      {error !== null && <p className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {t("layout.cancel")}
        </button>
        <button
          type="button"
          className="danger"
          data-testid="delete-table-confirm"
          disabled={baseHash === null || deleting}
          onClick={() => void onDelete()}
        >
          {t("tableDelete.confirm")}
        </button>
      </div>
    </Dialog>
  );
}
