/**
 * タグの正規化と検証（P-12）。サーバー側の erd.core.model.MetaRules と同じ規則を持つ。
 * 両側に置くのは、UI で防ぎつつ、手で編集したファイルや古いクライアントの書き込みも
 * サーバーで弾くため（片側だけだと必ず壊れた値が入る）。
 */

/** 1タグの最大長（コードポイント数）。 */
export const MAX_TAG_LENGTH = 32;

/** 1テーブル / 1カラムに付けられるタグの最大数。 */
export const MAX_TAGS = 20;

/** タグの区切りとして扱う文字（空白でタグを確定する UI に合わせる）。 */
const SEPARATORS = /[\s,、]+/u;

/** NFC 正規化 + 前後空白の除去。 */
export function normalizeTag(raw: string): string {
  return raw.normalize("NFC").trim();
}

/** 正規化 → 空要素の除去 → 重複除去（大小無視・先勝ち）。並びは入力順を保つ。 */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of raw) {
    const t = normalizeTag(tag);
    if (t === "") continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * 貼り付け・一括入力の分割（`core, auth 廃止` → 3件）。
 * 確定キー（空白）と同じ区切りで割るので、貼り付けと手入力の結果が一致する。
 */
export function splitTagInput(text: string): string[] {
  return normalizeTags(text.split(SEPARATORS));
}

export type TagErrorCode = "TAG_TOO_LONG" | "TAG_DUPLICATE";

/**
 * 確定しようとしているタグ1件の検証。問題なければ null。
 * 空白・区切り文字は {@link splitTagInput} で分割済みのため、ここでは長さと重複だけを見る。
 */
export function tagError(tag: string, existing: readonly string[]): TagErrorCode | null {
  if ([...tag].length > MAX_TAG_LENGTH) return "TAG_TOO_LONG";
  const key = tag.toLowerCase();
  if (existing.some((t) => t.toLowerCase() === key)) return "TAG_DUPLICATE";
  return null;
}
