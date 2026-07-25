/**
 * 差分ツリー（K-08）。
 *
 * 既定では変更のあるテーブルのみを列挙し、unchanged は件数のみ表示する（§3.1）。
 * <b>プレビューの価値の半分は「何が消えるか」を適用前に見せることにある</b>ため、
 * 失われるもの（論理名・注記・ER図の配置）の警告を項目に添える（§3.2）。
 */
import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import type { MsgKey } from "../i18n/messages";
import { cx } from "../lib/cx";
import { tableState } from "./selection";
import type { DiffItem } from "./types";
import styles from "./DiffTree.module.scss";

const CHANGE_MARK: Record<string, string> = {
  added: "+",
  removed: "−",
  modified: "~",
  renamed: "→",
  unchanged: "=",
};

// 動的 `diff-${change}` は camelCaseOnly で kebab キーが消えるため明示マップにする
const CHANGE_CLASS: Record<string, string | undefined> = {
  added: styles.diffAdded,
  removed: styles.diffRemoved,
  modified: styles.diffModified,
  renamed: styles.diffRenamed,
};

export function DiffTree({
  items,
  selection,
  onToggle,
  onIgnore,
}: {
  items: DiffItem[];
  selection: Set<string>;
  onToggle: (id: string) => void;
  onIgnore: (tableId: string) => void;
}) {
  const { t } = useI18n();
  const groups: { change: string; items: DiffItem[] }[] = [
    { change: "added", items: items.filter((i) => i.change === "added") },
    { change: "renamed", items: items.filter((i) => i.change === "renamed") },
    { change: "modified", items: items.filter((i) => i.change === "modified") },
    { change: "removed", items: items.filter((i) => i.change === "removed") },
  ];

  return (
    <div className="diff-tree">
      {groups.map(
        (g) =>
          g.items.length > 0 && (
            <section key={g.change} className={styles.diffGroup}>
              <h3>
                {t(`introspect.change.${g.change}` as MsgKey)} ({g.items.length})
              </h3>
              {g.items.map((item) => (
                <TableRow
                  key={item.id}
                  item={item}
                  selection={selection}
                  onToggle={onToggle}
                  onIgnore={onIgnore}
                />
              ))}
            </section>
          ),
      )}
    </div>
  );
}

function TableRow({
  item,
  selection,
  onToggle,
  onIgnore,
}: {
  item: DiffItem;
  selection: Set<string>;
  onToggle: (id: string) => void;
  onIgnore: (tableId: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(item.change === "modified");
  const state = tableState(item, selection);

  return (
    <div className={cx(styles.diffTable, CHANGE_CLASS[item.change])}>
      <div className={styles.diffRow}>
        <input
          type="checkbox"
          checked={state === "checked"}
          ref={(el) => {
            if (el) el.indeterminate = state === "partial";
          }}
          disabled={!item.selectable}
          title={item.selectable ? "" : t("introspect.forced")}
          onChange={() => onToggle(item.id)}
        />
        <button
          type="button"
          className={styles.diffToggle}
          onClick={() => setOpen(!open)}
          disabled={item.children.length === 0}
        >
          {item.children.length === 0 ? "　" : open ? "▼" : "▸"}
        </button>
        <span className={styles.diffMark}>{CHANGE_MARK[item.change]}</span>
        <span className={cx("mono", styles.diffTarget)}>
          {item.change === "renamed" ? `${item.renamedFrom} → ${item.target}` : item.target}
        </span>
        <span className={cx("muted", styles.diffSummary)}>{item.after ?? item.before}</span>
        {item.change === "removed" && (
          <button
            type="button"
            className="link-button"
            title={t("introspect.ignoreHint")}
            onClick={() => onIgnore(item.target)}
          >
            {t("introspect.ignoreAdd")}
          </button>
        )}
      </div>
      <Warnings item={item} />
      {open && item.children.length > 0 && (
        <div className="diff-children">
          {item.children.map((child) => (
            <ChildRow key={child.id} item={child} selection={selection} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChildRow({
  item,
  selection,
  onToggle,
}: {
  item: DiffItem;
  selection: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { t } = useI18n();
  const checked = item.selectable
    ? selection.has(item.id)
    : item.forcedBy.some((id) => selection.has(id)) || item.forcedBy.length === 0;

  return (
    <>
      <div className={cx(styles.diffRow, styles.diffChild)}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!item.selectable}
          title={item.selectable ? "" : t("introspect.forced")}
          onChange={() => onToggle(item.id)}
        />
        <span className={styles.diffMark}>{CHANGE_MARK[item.change]}</span>
        <span className={styles.diffKind}>{t(`introspect.kind.${item.kind}` as MsgKey)}</span>
        <span className={cx("mono", styles.diffTarget)}>
          {item.change === "renamed" && item.kind === "column"
            ? `${item.renamedFrom} → ${item.target}`
            : item.target}
        </span>
        <span className={styles.diffValues}>
          {item.before !== null && <del className="mono">{item.before}</del>}
          {item.before !== null && item.after !== null && " → "}
          {item.after !== null && <ins className="mono">{item.after}</ins>}
        </span>
      </div>
      <Warnings item={item} />
      {item.children.map((child) => (
        <ChildRow key={child.id} item={child} selection={selection} onToggle={onToggle} />
      ))}
    </>
  );
}

function Warnings({ item }: { item: DiffItem }) {
  const { t } = useI18n();
  if (item.warnings.length === 0) return null;
  return (
    <>
      {item.warnings.map((w, i) => (
        <div key={i} className="diff-warn">
          ⚠ {t(`introspect.warn.${w.code}` as MsgKey, { value: w.message ?? "" })}
        </div>
      ))}
    </>
  );
}
