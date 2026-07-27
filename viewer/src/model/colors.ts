/**
 * 色トークン（P-13）。テーブル / カラムに直接指定する色で、**タグとは独立**している
 * （タグに色を割り当てる仕組みは持たない）。
 *
 * 実際の配色は global.scss の `[data-color="…"]` が持つ。ここで hex を二重に持たないよう、
 * CSS が要らない箇所（MiniMap のように色を文字列で渡す API）だけ計算済みの値を引く。
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

const resolved = new Map<string, string>();

/**
 * トークンの実際の色を CSS 変数から引く（MiniMap 用）。
 * 変数は :root ではなく `[data-color]` 側にあるため、一時要素に属性を付けて解決する。
 */
export function tokenColor(color: string | undefined, part: "surface" | "border" | "text"): string | undefined {
  const token = colorAttr(color);
  if (token === undefined) return undefined;
  const key = `${token}:${part}`;
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;
  const probe = document.createElement("div");
  probe.setAttribute("data-color", token);
  probe.style.display = "none";
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).getPropertyValue(`--c-${part}`).trim();
  probe.remove();
  if (value === "") return undefined;
  resolved.set(key, value);
  return value;
}
