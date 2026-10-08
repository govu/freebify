import { describe, expect, it } from "vitest"
import { en } from "./locales/en"
import { es } from "./locales/es"

// every namespace file is spread into one flat map — a duplicate key across
// files would silently shadow. Count declared keys vs the merged result.
const enMods = import.meta.glob("./locales/en/*.ts", { eager: true })
const declared = Object.values(enMods).reduce<number>(
  (n, m) => n + Object.keys((m as { default: Record<string, string> }).default).length,
  0,
)

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe("locales", () => {
  it("en has no duplicate keys across namespace files", () => {
    expect(Object.keys(en).length).toBe(declared)
  })

  it("es has exactly the same keys as en", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort())
  })

  it("no empty values", () => {
    for (const [k, v] of Object.entries(en)) expect(v.trim().length, `en.${k}`).toBeGreaterThan(0)
    for (const [k, v] of Object.entries(es)) expect(v.trim().length, `es.${k}`).toBeGreaterThan(0)
  })

  it("interpolation placeholders match between locales", () => {
    for (const [k, v] of Object.entries(en)) {
      if (es[k] === undefined) continue
      expect(placeholders(es[k]), k).toEqual(placeholders(v))
    }
  })
})
