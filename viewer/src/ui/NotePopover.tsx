/**
 * 注記（人が書いた説明）をノートアイコン + ポップアップで見せる（閲覧側）。
 *
 * 一覧の行に本文をそのまま並べると、注記の長さで行の高さがばらつき、カラム一覧が縦に
 * 伸びすぎる。「注記があること」だけを一覧に残し、本文は**マウスを乗せたときに**読ませる。
 * ホバー・クリック・キーボードの機構は {@link InfoPopover} が持つ。
 */
import type { ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";
import { InfoPopover } from "./InfoPopover";
import styles from "./NotePopover.module.scss";

export function NotePopover({
  text,
  testId,
  dialogTitle,
}: {
  text: string;
  testId?: string;
  /** クリックで開くダイアログの見出し（既定は「注記」） */
  dialogTitle?: ReactNode;
}) {
  const { t } = useI18n();
  if (text === "") return null;
  return (
    <InfoPopover
      content={<div className={styles.text}>{text}</div>}
      icon={<NoteIcon />}
      label={t("table.showNotes")}
      testId={testId}
      dialogTitle={dialogTitle ?? t("table.colNotes")}
    />
  );
}

function NoteIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4h13l3 3v13H4z" />
      <line x1="8" y1="9" x2="15" y2="9" />
      <line x1="8" y1="13" x2="15" y2="13" />
      <line x1="8" y1="17" x2="12" y2="17" />
    </svg>
  );
}
