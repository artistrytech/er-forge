/**
 * テーブル一覧画面 `#/tables`（O-01）。
 * 列ソートと語句 / タグによる絞り込み。各行はテーブル詳細への実リンク。
 */
import { useMemo, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { resolveIndexTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import type { IndexTable } from "../model/types";
import { Link } from "../ui/Link";
import { hrefs } from "../ui/router";

type SortKey = "name" | "displayName" | "columns";

export function TableList() {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const manifest = useAppStore((s) => s.manifest);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = (index?.tables ?? []).filter((it) => {
      if (q === "") return true;
      const resolved = resolveIndexTableName(it);
      return (
        it.name.toLowerCase().includes(q) ||
        it.id.toLowerCase().includes(q) ||
        resolved.name.toLowerCase().includes(q) ||
        (it.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      );
    });
    const dir = sortAsc ? 1 : -1;
    const value = (it: IndexTable): string | number => {
      if (sortKey === "columns") return it.columns ?? 0;
      if (sortKey === "displayName") return resolveIndexTableName(it).name;
      return it.name;
    };
    return [...all].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), "ja") * dir;
    });
  }, [index, filter, sortKey, sortAsc]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const arrow = (key: SortKey) => (sortKey === key ? (sortAsc ? " ▲" : " ▼") : "");

  return (
    <div className="catalog-page">
      <div className="catalog-header">
        <h2>{t("catalog.title")}</h2>
        <input
          type="search"
          className="catalog-filter"
          placeholder={t("catalog.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted">{t("catalog.count", { n: rows.length })}</span>
      </div>
      <div className="table-scroll">
        <table className="data-table catalog-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => onSort("name")}>
                {t("catalog.colTable")}
                {arrow("name")}
              </th>
              <th className="sortable" onClick={() => onSort("displayName")}>
                {t("catalog.colLogicalName")}
                {arrow("displayName")}
              </th>
              <th className="sortable right" onClick={() => onSort("columns")}>
                {t("catalog.colColumns")}
                {arrow("columns")}
              </th>
              <th>{t("catalog.colTags")}</th>
              <th>{t("catalog.colPages")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => {
              const resolved = resolveIndexTableName(it);
              return (
                <tr key={it.id}>
                  <td className="mono">
                    <Link href={hrefs.table(it.id)}>{it.name}</Link>
                  </td>
                  <td>
                    {resolved.source === "physical" ? (
                      <span className="muted">（{t("table.notSet")}）</span>
                    ) : (
                      resolved.name
                    )}
                  </td>
                  <td className="right">{it.columns ?? ""}</td>
                  <td>
                    {(it.tags ?? []).map((tag) => (
                      <span key={tag} className="tag">
                        {tag}
                      </span>
                    ))}
                  </td>
                  <td>
                    {(it.diagrams ?? []).length === 0 ? (
                      <span className="muted">{t("sidebar.unplaced")}</span>
                    ) : (
                      it.diagrams?.map((d) => (
                        <Link key={d} className="page-chip" href={hrefs.erd(d, it.id)}>
                          {manifest?.diagrams?.find((x) => x.id === d)?.title ?? d}
                        </Link>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
