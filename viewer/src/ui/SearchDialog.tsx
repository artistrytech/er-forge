/**
 * 全体検索（F-01〜F-05）。Cmd/Ctrl+K で開く。
 * ヒットはテーブル別にグルーピングし、ER図 / テーブル詳細への実リンクを出す。
 * 全テーブル未ロード時は index の範囲で検索し、その旨を表示する（F-04）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { formatName, resolveIndexTableName } from "../model/logicalName";
import { searchAll } from "../model/search";
import { totalTableCount, useAppStore } from "../model/store";
import { Dialog } from "./Dialog";
import { Link } from "./Link";
import { hrefs } from "./router";

export function SearchDialog() {
  const { t } = useI18n();
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const index = useAppStore((s) => s.index);
  const tables = useAppStore((s) => s.tables);
  const dictionary = useAppStore((s) => s.dictionary);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const loadedCount = useAppStore((s) => s.loadedTableCount);
  const failedCount = useAppStore((s) => s.failedTableCount);
  const total = useAppStore((s) => totalTableCount(s));

  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => setSearchOpen(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hits = useMemo(
    () => (index ? searchAll(query, index, tables, dictionary) : []),
    [query, index, tables, dictionary],
  );

  const partial = loadedCount + failedCount < total;

  return (
    <Dialog title={t("nav.search")} onClose={close} wide>
      <input
        ref={inputRef}
        type="search"
        className="search-input"
        placeholder={t("search.placeholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {partial && query.trim() !== "" && (
        <p className="muted small">{t("search.partial", { loaded: loadedCount + failedCount, total })}</p>
      )}
      {query.trim() === "" ? (
        <p className="muted">{t("search.hint")}</p>
      ) : hits.length === 0 ? (
        <p className="muted">{t("search.empty")}</p>
      ) : (
        <ul className="search-results">
          {hits.map((hit) => {
            const it = index?.tables?.find((x) => x.id === hit.tableId);
            if (!it) return null;
            const label = formatName(resolveIndexTableName(it), it.name, nameDisplay);
            const firstDiagram = it.diagrams?.[0];
            return (
              <li key={hit.tableId} className="search-result">
                <div className="search-result-head">
                  <Link href={hrefs.table(hit.tableId)} onClick={close}>
                    {label}
                  </Link>
                  <span className="search-result-actions">
                    {firstDiagram !== undefined && (
                      <Link
                        className="page-chip"
                        href={hrefs.erd(firstDiagram, hit.tableId)}
                        onClick={close}
                      >
                        {t("search.openErd")}
                      </Link>
                    )}
                    <Link className="page-chip" href={hrefs.table(hit.tableId)} onClick={close}>
                      {t("search.openDetail")}
                    </Link>
                  </span>
                </div>
                {hit.columnHits.length > 0 && (
                  <ul className="search-columns">
                    {hit.columnHits.map((c) => (
                      <li key={c.column}>
                        <span className="mono">{c.column}</span>
                        {c.logicalName !== c.column && <span> — {c.logicalName}</span>}
                        {c.matched !== c.column && c.matched !== c.logicalName && (
                          <span className="muted"> ({c.matched})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
