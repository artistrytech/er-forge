/**
 * className を条件付きで合成する小さなヘルパー。
 * CSS Modules 化に伴い `"a" + (cond ? " b" : "")` のような文字列連結を
 * `cx(styles.a, cond && styles.b)` へ置き換えるために使う。
 * falsy（false / null / undefined / ""）は除外する。
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
