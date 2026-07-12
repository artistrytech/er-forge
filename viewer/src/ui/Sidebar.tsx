/**
 * サイドバー（B-01〜B-05）。
 * ページ一覧（order 順・テーブル数併記）と全テーブル一覧（未配置セクション付き）。
 * 各項目は実リンク（X-04）。
 */
import { useMemo } from "react";
import { useI18n } from "../i18n/useI18n";
import { formatName, resolveIndexTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import { Link } from "./Link";
import { hrefs } from "./router";

export function Sidebar({ currentDiagramId }: { currentDiagramId?: string }) {
  const { t } = useI18n();
  const manifest = useAppStore((s) => s.manifest);
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);

  const diagrams = useMemo(
    () => [...(manifest?.diagrams ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [manifest],
  );

  const tableCountByDiagram = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of index?.tables ?? []) {
      for (const d of it.diagrams ?? []) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return counts;
  }, [index]);

  const sortedTables = useMemo(
    () => [...(index?.tables ?? [])].sort((a, b) => a.name.localeCompare(b.name, "ja")),
    [index],
  );
  const placed = sortedTables.filter((it) => (it.diagrams ?? []).length > 0);
  const unplaced = sortedTables.filter((it) => (it.diagrams ?? []).length === 0);

  return (
    <nav className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-heading">{t("sidebar.pages")}</div>
        <ul>
          {diagrams.map((d) => (
            <li key={d.id}>
              <Link
                href={hrefs.erd(d.id)}
                className={"sidebar-link" + (d.id === currentDiagramId ? " active" : "")}
              >
                {d.title ?? d.id}
                <span className="sidebar-count">
                  {t("sidebar.tableCount", { n: tableCountByDiagram.get(d.id) ?? 0 })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-heading">{t("sidebar.tables")}</div>
        <ul>
          {placed.map((it) => {
            // 現在のページにあればそのページへ、なければ最初の所属ページへ（B-04）
            const target =
              currentDiagramId !== undefined && (it.diagrams ?? []).includes(currentDiagramId)
                ? currentDiagramId
                : it.diagrams?.[0];
            const label = formatName(resolveIndexTableName(it), it.name, nameDisplay);
            return (
              <li key={it.id}>
                <Link
                  className="sidebar-link"
                  href={target !== undefined ? hrefs.erd(target, it.id) : hrefs.table(it.id)}
                >
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      {unplaced.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-heading">{t("sidebar.unplaced")}</div>
          <ul>
            {unplaced.map((it) => (
              <li key={it.id}>
                <Link className="sidebar-link muted" href={hrefs.table(it.id)}>
                  {formatName(resolveIndexTableName(it), it.name, nameDisplay)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
