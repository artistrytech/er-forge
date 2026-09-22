/**
 * 色トークン（P-13）。テーブル / カラムに直接指定する色で、**タグとは独立**している
 * （タグに色を割り当てる仕組みは持たない）。
 *
 * 実際の配色は global.scss の `[data-color="…"]` が持つ。ここでは hex を二重に持たず、
 * 描画側は `data-color` 属性を付けて CSS 変数（--c-surface / --c-border / --c-text）を使う。
 *
 * サーバー側の一覧は erd.core.model.ColorToken。**並び順まで一致させること**（UI の表示順）。
 */
export const COLOR_TOKENS = ["gray", "red", "amber", "green", "blue", "purple", "muted"] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

export function isColorToken(value: string | undefined): value is ColorToken {
  return value !== undefined && (COLOR_TOKENS as readonly string[]).includes(value);
}

/**
 * 未知のトークンは「色の指定なし」として扱う（既定の外観にフォールバックする）。
 * 手で編集したファイルや将来のトークンで描画が壊れないようにするためで、値自体は保持される。
 */
export function colorAttr(color: string | undefined): string | undefined {
  return isColorToken(color) ? color : undefined;
}

