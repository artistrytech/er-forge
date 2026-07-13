/**
 * カラム論理名の一括編集画面 `#/columns`（P-03）。
 *
 * 全テーブルのカラム物理名を distinct にした行集合に対して、横断辞書
 * （dictionary.js）を表形式で編集し、全体を1回の PUT で置換する（§2.4）。
 * 全テーブルのロード完了までは編集は可能だが保存は待たせる（§2.5）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiGet, apiPut } from "../model/api";
import { aggregateColumns, parseTsvPairs } from "../model/columnDictionary";
import { currentLockId, notifyLockLost, rememberOwnRevision } from "../model/editStore";
import { reloadDictionary } from "../model/loader";
import { totalTableCount, useAppStore } from "../model/store";
import { Dialog } from "../ui/Dialog";
import { EditSessionGate, useFormSessionReady } from "../ui/EditSessionGate";
import { hrefs } from "../ui/router";

type Filter = "all" | "unset" | "overridden" | "orphan";

export function ColumnsPage() {
  const { t } = useI18n();
  const tables = useAppStore((s) => s.tables);
  const dictionary = useAppStore((s) => s.dictionary);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const total = useAppStore((s) => totalTableCount(s));
  const addToast = useAppStore((s) => s.addToast);
  const sessionReady = useFormSessionReady();

  const allLoaded = loaded + failed >= total;

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
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
    apiGet("/__erd/dictionary").then(
      (res) => {
        if (res.status === 200) {
          setBaseHash((JSON.parse(res.body) as { baseHash: string }).baseHash);
        }
      },
      () => undefined,
    );
  }, []);

  const rows = useMemo(
    () => aggregateColumns(Object.values(tables), dictionary?.columns ?? {}),
    [tables, dictionary],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const value = draft[r.name] ?? "";
      if (filter === "unset" && value !== "") return false;
      if (filter === "overridden" && r.overrides.length === 0) return false;
      if (filter === "orphan" && r.occurrences > 0) return false;
      if (q !== "" && !r.name.toLowerCase().includes(q) && !value.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [rows, draft, filter, search]);

  const dirty = dirtyKeys.size > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // O-09 と同じ未保存警告
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  useEffect(() => {
    const ownHash = hrefs.columns();
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
  }, [t]);

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
      const res = await apiPut("/__erd/dictionary", {
        lockId: currentLockId(),
        baseHash,
        force,
        columns,
      });
      if (res.status === 200) {
        const body = JSON.parse(res.body) as { revision: string; newHash: string };
        rememberOwnRevision(body.revision);
        setBaseHash(body.newHash);
        setDirtyKeys(new Set());
        dirtyRef.current = false;
        await reloadDictionary(body.revision);
        addToast(t("tableEdit.saved"));
      } else if (res.status === 409) {
        setConflict(true);
      } else if (res.status === 423) {
        notifyLockLost();
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
      </div>
      <p className="muted form-hint">{t("columnsPage.hint")}</p>

      <EditSessionGate />
      {!allLoaded && (
        <div className="notice-banner">
          {t("columnsPage.loading", { loaded: loaded + failed, total })} — {t("columnsPage.saveWaiting")}
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
          disabled={!dirty || saving || !allLoaded || !sessionReady || baseHash === null}
          onClick={() => void save(false)}
        >
          {saving ? t("save.saving") : t("save.button")}
        </button>
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
                    <input
                      type="text"
                      value={value}
                      placeholder={`（${t("table.notSet")}）`}
                      disabled={!sessionReady}
                      onChange={(e) => setValue(r.name, e.target.value)}
                    />
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
