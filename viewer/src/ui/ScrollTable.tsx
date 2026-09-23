/**
 * 縦スクロールする表（ヘッダ固定）。
 *
 * カラム辞書の一覧（P-03。仮想化あり）と、テーブル詳細・編集のカラム一覧（仮想化なし）で
 * 共用する。ここが持つのは「スクロールの器」と「sticky な thead」だけで、**仮想化は
 * 呼び出し側の責務**にしてある（行の高さを固定できるのは辞書だけで、詳細のカラム表は
 * タグ・注記で高さが揃わないため）。仮想化する側は scrollRef を渡してビューポートを測る
 * （lib/virtualRows.ts）。
 *
 * 高さの決め方は2通り:
 * - `fill`: 親（flex コンテナ）の残りいっぱい。カラム辞書はビューポート高が要るのでこちら。
 * - 既定: 内容なり。上限は呼び出し側が className で max-height を与える。
 */
import type { ReactNode, RefObject } from "react";
import { cx } from "../lib/cx";
import styles from "./ScrollTable.module.scss";

interface ScrollTableProps {
  /**
   * thead に入れる中身（`<tr>…</tr>`）。
   * 省略すると thead ごと出さない（項目名が行の中にある表 = テーブル情報・制約）
   */
  head?: ReactNode;
  /** tbody に入れる行 */
  children: ReactNode;
  /** 親の残り高さいっぱいに広げる（既定は内容なり） */
  fill?: boolean;
  /** スクロール器に足すクラス（max-height はここで与える） */
  className?: string;
  /** 表そのものに足すクラス */
  tableClassName?: string;
  /** 仮想化のためにビューポートを測る側が渡す */
  scrollRef?: RefObject<HTMLDivElement | null>;
  testId?: string;
}

export function ScrollTable({
  head,
  children,
  fill,
  className,
  tableClassName,
  scrollRef,
  testId,
}: ScrollTableProps) {
  return (
    <div
      className={cx("table-scroll", styles.scroll, fill === true && styles.fill, className)}
      ref={scrollRef}
      data-testid={testId}
    >
      <table className={cx("data-table", tableClassName)}>
        {head !== undefined && <thead className={styles.head}>{head}</thead>}
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
