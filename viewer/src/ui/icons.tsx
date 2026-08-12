/**
 * 画面をまたいで同じ意味で使うアイコン（インライン SVG。静的モードでは外部アイコン
 * フォントを使えないため）。
 *
 * ここに置くのは**複数の画面で同じ意味を担うもの**だけ。1画面でしか使わないアイコンは
 * その画面のファイルに置いたままにする。
 */

/**
 * 編集（ペン）。ヘッダの [編集開始]、左パネルの行の近道、ページ管理のどれでも同じ形にする。
 * ペン先は左下・持ち手は右上。**向きが揃っていないと別の操作に見える**ため、
 * 「✎」（U+270E: 逆向きのペン）などの文字では代用しない。
 */
export function PenIcon({ size = 18, strokeWidth = 1.8 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
