/**
 * sessionStorage に預ける文字列状態（**タブ単位**）。
 *
 * 復元は**マウント時に一度だけ**行う。左パネルのレーンは切り替えるたびに再マウントされる
 * ため、これで「レーンを移って戻る」「画面を移って戻る」「リロード」のいずれでも入力が
 * 戻る。書き込みは値が変わったときだけで、空文字はキーごと消す（残骸を残さない）。
 *
 * sessionStorage が使えない環境（プライベートモード等）でも動く必要があるため、
 * 読み書きは常に try / catch で包み、失敗してもメモリ内の状態だけで通常どおり動く。
 */
import { useCallback, useState } from "react";

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    if (value === "") sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // 保持できないだけで、その画面にいる間の状態は保たれる（致命的ではない）
  }
}

/**
 * @param fallback 保持された値が無い / 受け付けられないときの初期値
 * @param isValid 保持された値を採用してよいか（選択肢が決まっている項目で使う。
 *   古いキーや手で書き換えられた値をそのまま状態に入れない）
 */
export function useSessionState<T extends string>(
  key: string,
  fallback: T,
  isValid?: (value: string) => boolean,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = read(key);
    if (stored === null) return fallback;
    return isValid !== undefined && !isValid(stored) ? fallback : (stored as T);
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      write(key, next);
    },
    [key],
  );

  return [value, update];
}
