/**
 * カラム論理名の一括編集画面（P-03）。
 *
 * 閲覧ルート `#/columns` と編集ルート `#/columns/edit` を分ける（§2.4）。
 * 閲覧ルートでは辞書を読み取り表示し、[編集開始] で編集ルートへ遷移して初めて編集できる。
 * 静的モードでは閲覧のみ（[編集開始] を出さない）。編集ロックは無い（H-11 廃止）。
 * 全体を1回の PUT で置換し、保存後は閲覧モード（#/columns）へ戻る。
 * 全テーブルのロード完了までは編集は可能だが保存は待たせる（§2.5）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiGet, apiPut } from "../model/api";
import { aggregateColumns, parseTsvPairs } from "../model/columnDictionary";
import { rememberOwnRevision } from "../model/editStore";
import { reloadDictionary } from "../model/loader";
import { matchText, type MatchMode } from "../model/search";
import { totalTableCount, useAppStore } from "../model/store";
import { Dialog } from "../ui/Dialog";
import { Link } from "../ui/Link";
import { hrefs, type ColumnMatch } from "../ui/router";

type Filter = "all" | "unset" | "overridden" | "orphan";

const MATCH_MODES: MatchMode[] = ["partial", "prefix", "suffix", "exact"];

export function ColumnsPage({
  editing,
  focusColumn,
  focusMatch,
}: {
  editing: boolean;
  /** 検索モーダルからの遷移時に絞り込む物理カラム名（回答A） */
  focusColumn?: string;
  focusMatch?: ColumnMatch;
}) {
  const { t } = useI18n();
  const tables = useAppStore((s) => s.tables);
  const dictionary = useAppStore((s) => s.dictionary);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const total = useAppStore((s) => totalTableCount(s));
  const addToast = useAppStore((s) => s.addToast);
  const serverMode = useAppStore((s) => s.serverMode === true);
  // 編集ルートにいる時点で編集モード（App は静的モードだと閲覧へリダイレクトする）
  const canEdit = editing && serverMode;

  const allLoaded = loaded + failed >= total;

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState(focusColumn ?? "");
  const [matchMode, setMatchMode] = useState<MatchMode>(focusMatch ?? "partial");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

  // 辞書の初期値と baseHash。辞書が外部変更されたら未編集キーのみ追随する
  useEffect(() => {
    setDraft((prev) => {
      const next: Record<string, string> = { ...(dictionary?.columns ?? {}) };
      for (const key of dirtyKeys) {
        if (prev[key] !== undefined) next[key] = prev[key];
        else delete next[key];
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictionary]);
  useEffect(() => {
    // baseHash は保存にのみ使う。閲覧モード / 静的モードでは取りに行かない
    if (!canEdit) return;
    apiGet("/__erd/dictionary").then(
      (res) => {
        if (res.status === 200) {
          setBaseHash((JSON.parse(res.body) as { baseHash: string }).baseHash);
        }
      },
      () => undefined,
    );
  }, [canEdit]);

  // 検索モーダルからの遷移（focusColumn / focusMatch）で絞り込みを張り替える（回答A）。
  // マウント継続中に別のカラムへ遷移した場合にも追随する
  useEffect(() => {
    if (focusColumn !== undefined) {
      setSearch(focusColumn);
      setMatchMode(focusMatch ?? "exact");
    }
  }, [focusColumn, focusMatch]);

  const rows = useMemo(
    () => aggregateColumns(Object.values(tables), dictionary?.columns ?? {}),
    [tables, dictionary],
  );

  const visible = useMemo(() => {
    const q = search.trim();
    return rows.filter((r) => {
      const value = draft[r.name] ?? "";
      if (filter === "unset" && value !== "") return false;
      if (filter === "overridden" && r.overrides.length === 0) return false;
      if (filter === "orphan" && r.occurrences > 0) return false;
      if (q !== "" && !matchText(r.name, q, matchMode) && !matchText(value, q, matchMode)) {
        return false;
      }
      return true;
    });
  }, [rows, draft, filter, search, matchMode]);

  const dirty = dirtyKeys.size > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // O-09 と同じ未保存警告（編集ルートでのみ）
  useEffect(() => {
    if (!canEdit) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [canEdit]);
  useEffect(() => {
    if (!canEdit) return;
    const ownHash = hrefs.columnsEdit();
    const onHashChange = () => {
      if (!dirtyRef.current || location.hash === ownHash) return;
      if (!window.confirm(t("tableEdit.leaveConfirm"))) {
        location.hash = ownHash;
      } else {
        dirtyRef.current = false;
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [canEdit, t]);

  const setValue = (name: string, value: string) => {
    setDraft((d) => ({ ...d, [name]: value }));
    setDirtyKeys((keys) => new Set(keys).add(name));
  };

  const applyPaste = () => {
    const pairs = parseTsvPairs(pasteText);
    const known = new Set(rows.map((r) => r.name));
    let applied = 0;
    setDraft((d) => {
      const next = { ...d };
      const nextDirty = new Set(dirtyKeys);
      for (const [name, value] of pairs) {
        if (!known.has(name)) continue;
        next[name] = value;
        nextDirty.add(name);
        applied += 1;
      }
      setDirtyKeys(nextDirty);
      return next;
    });
    setPasteOpen(false);
    setPasteText("");
    addToast(t("columnsPage.pasteApplied", { n: applied }));
  };

  const save = async (force: boolean) => {
    if (saving || baseHash === null) return;
    const columns: Record<string, string> = {};
    for (const [name, value] of Object.entries(draft)) {
      if (value.trim() !== "") columns[name] = value.trim();
    }
    setSaving(true);
    try {
      const res = await apiPut("/__erd/dictionary", { baseHash, force, columns });
      if (res.status === 200) {
        const body = JSON.parse(res.body) as { revision: string; newHash: string };
        rememberOwnRevision(body.revision);
        setBaseHash(body.newHash);
        setDirtyKeys(new Set());
        dirtyRef.current = false;
        await reloadDictionary(body.revision);
        addToast(t("tableEdit.saved"));
        // 保存後は閲覧モードへ戻る（テーブル編集と同様。§2.4）
        location.hash = hrefs.columns();
      } else if (res.status === 409) {
        setConflict(true);
      } else {
        addToast(`${t("save.failed")} (HTTP ${res.status})`);
      }
    } catch {
      addToast(`${t("save.failed")} (network)`);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft({ ...(dictionary?.columns ?? {}) });
    setDirtyKeys(new Set());
  };

  const reloadFromServer = async () => {
    setConflict(false);
    await reloadDictionary(String(Date.now()));
    const res = await apiGet("/__erd/dictionary");
    if (res.status === 200) {
      setBaseHash((JSON.parse(res.body) as { baseHash: string }).baseHash);
    }
    discard();
  };

  return (
    <div className="catalog-page columns-page">
      <div className="catalog-header">
        <h2>{t("columnsPage.title")}</h2>
        <span className="muted">{t("columnsPage.count", { n: rows.length })}</span>
        {!editing && serverMode && (
          <Link className="header-button header-button-primary" href={hrefs.columnsEdit()}>
            {t("session.startEdit")}
          </Link>
        )}
      </div>
      <p className="muted form-hint">{t("columnsPage.hint")}</p>

      {canEdit && !allLoaded && (
        <div className="notice-banner">
          {t("columnsPage.loading", { loaded: loaded + failed, total })} — {t("columnsPage.saveWaiting")}
        </div>
      )}

      {focusColumn !== undefined && (
        <div className="notice-banner">
          {t("columnsPage.focusNotice", {
            name: focusColumn,
            match: t(`columnsPage.match.${focusMatch ?? "exact"}` as const),
          })}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setSearch("");
              setMatchMode("partial");
              location.hash = hrefs.columns();
            }}
          >
            {t("columnsPage.clearFocus")}
          </button>
        </div>
      )}

      <div className="columns-toolbar">
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">{t("columnsPage.filter.all")}</option>
          <option value="unset">{t("columnsPage.filter.unset")}</option>
          <option value="overridden">{t("columnsPage.filter.overridden")}</option>
          <option value="orphan">{t("columnsPage.filter.orphan")}</option>
        </select>
        <input
          type="search"
          className="catalog-filter"
          placeholder={t("columnsPage.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={matchMode}
          onChange={(e) => setMatchMode(e.target.value as MatchMode)}
          title={t("panel.lane.search")}
        >
          {MATCH_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`columnsPage.match.${m}` as const)}
            </option>
          ))}
        </select>
        {canEdit && (
          <>
            <button type="button" className="header-button" onClick={() => setPasteOpen(true)}>
              {t("columnsPage.paste")}
            </button>
            <span className="spacer" />
            <button type="button" className="header-button" disabled={!dirty || saving} onClick={discard}>
              {t("tableEdit.discard")}
            </button>
            <button
              type="button"
              className="header-button header-button-primary"
              data-testid="save-button"
              disabled={!dirty || saving || !allLoaded || baseHash === null}
              onClick={() => void save(false)}
            >
              {saving ? t("save.saving") : t("save.button")}
            </button>
          </>
        )}
      </div>

      <div className="table-scroll">
        <table className="data-table columns-table">
          <thead>
            <tr>
              <th>{t("columnsPage.colName")}</th>
              <th>{t("columnsPage.colLogical")}</th>
              <th className="right">{t("columnsPage.colOccurrences")}</th>
              <th className="right">{t("columnsPage.colOverrides")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const value = draft[r.name] ?? "";
              return (
                <tr key={r.name} className={dirtyKeys.has(r.name) ? "row-dirty" : ""}>
                  <td className="mono">{r.name}</td>
                  <td>
                    {canEdit ? (
                      <input
                        type="text"
                        value={value}
                        placeholder={`（${t("table.notSet")}）`}
                        onChange={(e) => setValue(r.name, e.target.value)}
                      />
                    ) : (
                      <span className={value === "" ? "muted" : ""}>
                        {value === "" ? `（${t("table.notSet")}）` : value}
                      </span>
                    )}
                  </td>
                  <td className="right" title={r.occurrenceTables.join(", ")}>
                    {r.occurrences}
                    {r.occurrences === 0 && (
                      <span className="badge badge-warn" title={t("columnsPage.orphan")}>
                        ⚠
                      </span>
                    )}
                  </td>
                  <td
                    className="right"
                    title={
                      r.overrides.length > 0
                        ? t("columnsPage.overriddenBy", { list: r.overrides.join(", ") })
                        : ""
                    }
                  >
                    {r.overrides.length}
                    {r.overrides.length > 0 && <span className="badge badge-warn">⚠</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pasteOpen && (
        <Dialog title={t("columnsPage.paste")} onClose={() => setPasteOpen(false)}>
          <p className="muted">{t("columnsPage.pasteHint")}</p>
          <textarea
            className="paste-area mono"
            rows={12}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={"created_at\t作成日時\nupdated_at\t更新日時"}
          />
          <div className="dialog-actions">
            <button type="button" onClick={() => setPasteOpen(false)}>
              {t("dialog.cancel")}
            </button>
            <button type="button" className="primary" onClick={applyPaste}>
              {t("columnsPage.pasteApply")}
            </button>
          </div>
        </Dialog>
      )}

      {conflict && (
        <Dialog title={t("edit.conflict.title")} onClose={() => setConflict(false)}>
          <p>{t("columnsPage.conflictBody")}</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => void reloadFromServer()}>
              {t("edit.conflict.reload")}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConflict(false);
                void save(true);
              }}
            >
              {t("edit.conflict.overwrite")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
