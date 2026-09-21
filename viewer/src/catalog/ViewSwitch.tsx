/**
 * テーブル画面の右ペインの表示モード切替（R-02）。「詳細 | ドキュメント」のセグメント。
 *
 * 両方とも**実リンク**（X-04）。同じテーブルを保ったまま `#/tables/<id>` ⇄ `#/tables/doc/<id>` を
 * 行き来する。どちらを使っているかは着地したルートで App が記憶する（ここでは書かない）。
 */
import { useI18n } from "../i18n/useI18n";
import type { TablesView } from "../model/store";
import { cx } from "../lib/cx";
import { Link } from "../ui/Link";
import { hrefs } from "../ui/router";
import styles from "./ViewSwitch.module.scss";

export function ViewSwitch({ view, tableId }: { view: TablesView; tableId?: string }) {
  const { t } = useI18n();
  const items: { id: TablesView; label: string; href: string }[] = [
    {
      id: "detail",
      label: t("doc.view.detail"),
      href: tableId !== undefined ? hrefs.table(tableId) : hrefs.tables(),
    },
    { id: "doc", label: t("doc.view.doc"), href: hrefs.tableDoc(tableId) },
  ];
  return (
    <nav className={styles.switch} aria-label={t("doc.view.label")} data-testid="view-switch">
      {items.map((it) => (
        <Link
          key={it.id}
          href={it.href}
          className={cx(styles.item, view === it.id && styles.active)}
          aria-current={view === it.id ? "page" : undefined}
          data-testid={`view-${it.id}`}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
