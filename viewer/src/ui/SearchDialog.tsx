/**
 * 全体検索モーダル（F-01〜F-05）。Cmd/Ctrl+K で開く（ヘッダの検索ボタンは廃止）。
 *
 * 回答A: モーダルでは検索条件を細かく指定しない（常に全条件・部分一致で検索）。
 * 遷移先はタブで選ぶ（テーブル詳細 / ER図 / カラム論理名）。カラム論理名タブは、
 * ヒットしたカラム物理名で完全一致フィルタした一括編集画面へ遷移する。
 * 全テーブル未ロード時は index の範囲で検索し、その旨を表示する（F-04）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { formatName, resolveIndexTableName } from "../model/logicalName";
import { searchAll } from "../model/search";
import { totalTableCount, useAppStore } from "../model/store";
import { cx } from "../lib/cx";
import { Dialog } from "./Dialog";
import { Link } from "./Link";
import { hrefs } from "./router";
import styles from "./SearchDialog.module.scss";

type Tab = "detail" | "erd" | "columns";

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
  const [tab, setTab] = useState<Tab>("detail");
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
  const tabs: Tab[] = ["detail", "erd", "columns"];

  return (
    <Dialog title={t("nav.search")} onClose={close} wide>
      <input
        ref={inputRef}
        type="search"
        className={styles.searchInput}
        data-testid="search-input"
        placeholder={t("search.placeholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={styles.searchTabs} role="tablist">
        {tabs.map((tb) => (
          <button
            key={tb}
            type="button"
            role="tab"
            aria-selected={tab === tb}
            className={cx(styles.searchTab, tab === tb && styles.active)}
            onClick={() => setTab(tb)}
          >
            {t(`search.tab.${tb}` as const)}
          </button>
        ))}
      </div>
      {partial && query.trim() !== "" && (
        <p className="muted small">
          {t("search.partial", { loaded: loadedCount + failedCount, total })}
        </p>
      )}
      {query.trim() === "" ? (
        <p className="muted">{t("search.hint")}</p>
      ) : hits.length === 0 ? (
        <p className="muted">{t("search.empty")}</p>
      ) : (
        <ul className={styles.searchResults}>
          {hits.map((hit) => {
            const it = index?.tables?.find((x) => x.id === hit.tableId);
            if (!it) return null;
            const label = formatName(resolveIndexTableName(it), it.name, nameDisplay);
            const firstDiagram = it.diagrams?.[0];

            // カラム論理名タブ: ヒットしたカラム物理名で完全一致フィルタ（回答A）
            if (tab === "columns") {
              if (hit.columnHits.length === 0) return null;
              return (
                <li key={hit.tableId} className={styles.searchResult} data-testid="search-result">
                  <div className={styles.searchResultHead}>
                    <span className="muted">{label}</span>
                  </div>
                  <ul className={styles.searchColumns}>
                    {hit.columnHits.map((c) => (
                      <li key={c.column}>
                        <Link href={hrefs.columns(c.column, "exact")} onClick={close}>
                          <span className="mono">{c.column}</span>
                        </Link>
                        {c.logicalName !== c.column && <span> — {c.logicalName}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            }

            // テーブル詳細 / ER図タブ: テーブル単位で遷移
            const href =
              tab === "erd" && firstDiagram !== undefined
                ? hrefs.erd(firstDiagram, hit.tableId)
                : hrefs.table(hit.tableId);
            const disabled = tab === "erd" && firstDiagram === undefined;
            return (
              <li key={hit.tableId} className={styles.searchResult} data-testid="search-result">
                <div className={styles.searchResultHead}>
                  {disabled ? (
                    <span className="muted" title={t("table.unplacedNote")}>
                      {label}
                    </span>
                  ) : (
                    <Link href={href} onClick={close}>
                      {label}
                    </Link>
                  )}
                </div>
                {hit.columnHits.length > 0 && (
                  <ul className={styles.searchColumns}>
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
