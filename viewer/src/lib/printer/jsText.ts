/**
 * JavaScript のキー引用と文字列エスケープ（Phase0 詳細設計 §2.3 / §2.5）。
 * サーバー側の erd.core.io.JsText と出力がバイト一致すること（INV-3）。
 * 変更するときは必ず両方を変更し、golden fixture で一致を確認する。
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
]);

/** キーの出力形。識別子として妥当かつ予約語でなければ裸、それ以外は二重引用符。 */
export function key(k: string): string {
  if (IDENTIFIER.test(k) && !RESERVED.has(k)) {
    return k;
  }
  return quote(k);
}

/** 文字列リテラル。二重引用符 + §2.5 のエスケープ。非 ASCII はエスケープしない（INV-4）。 */
export function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i]!;
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (c === 0x2028) {
      out += "\\u2028";
    } else if (c === 0x2029) {
      out += "\\u2029";
    } else if (c < 0x20) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

/** ソートは常に Unicode コードポイント順（ロケール依存ソートは INV-2 を破る）。 */
export function codepointCompare(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return (a.length - i) - (b.length - j);
}
