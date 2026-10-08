import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { safeStorage } from "../store/storage"
import { en } from "./locales/en"
import { es } from "./locales/es"

export type Lang = "en" | "es"
export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
]

const LOCALES: Record<Lang, Record<string, string>> = { en, es }

const detect = (): Lang => (navigator.language || "").toLowerCase().startsWith("es") ? "es" : "en"

interface I18nState {
  lang: Lang
  setLang: (lang: Lang) => void
}

export const useI18n = create<I18nState>()(
  persist(
    (set) => ({
      lang: detect(),
      setLang: (lang) => set({ lang }),
    }),
    {
      name: "freebify-lang",
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ lang: s.lang }),
    },
  ),
)

const applyHtmlLang = (l: Lang) => {
  try {
    document.documentElement.lang = l
  } catch {}
}
applyHtmlLang(useI18n.getState().lang)
useI18n.subscribe((s) => applyHtmlLang(s.lang))

// locale for Intl/toLocale* calls — follows the app language, not the OS
export const dateLocale = () => (useI18n.getState().lang === "es" ? "es-ES" : "en-US")

const interpolate = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s

// non-reactive lookup — toasts, event handlers, anything outside render
export const t = (key: string, vars?: Record<string, string | number>) => {
  const lang = useI18n.getState().lang
  return interpolate(LOCALES[lang][key] ?? en[key] ?? key, vars)
}

// reactive hook — consumers re-render when the language switches
export function useT() {
  const lang = useI18n((s) => s.lang)
  return (key: string, vars?: Record<string, string | number>) =>
    interpolate(LOCALES[lang][key] ?? en[key] ?? key, vars)
}
