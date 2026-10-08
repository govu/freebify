import pages1 from "./es/pages1"
import pages2 from "./es/pages2"
import chrome from "./es/chrome"
import overlays from "./es/overlays"
import core from "./es/core"

export const es: Record<string, string> = { ...pages1, ...pages2, ...chrome, ...overlays, ...core }
