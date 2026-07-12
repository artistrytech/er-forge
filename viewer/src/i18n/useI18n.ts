/** 翻訳フック。言語はストアの個人設定に従う（X-01 / L-04） */
import { useCallback } from "react";
import { useAppStore } from "../model/store";
import { translate, type Lang, type MsgKey } from "./messages";

export type Translator = (key: MsgKey, vars?: Record<string, string | number>) => string;

export function useI18n(): { t: Translator; lang: Lang; setLang: (lang: Lang) => void } {
  const lang = useAppStore((s) => s.lang);
  const setLang = useAppStore((s) => s.setLang);
  const t = useCallback<Translator>((key, vars) => translate(lang, key, vars), [lang]);
  return { t, lang, setLang };
}
