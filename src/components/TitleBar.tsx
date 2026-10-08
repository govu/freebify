import { Copy, Minus, Square, X } from "lucide-react"
import { useEffect, useState } from "react"
import { useT } from "../i18n"

// Floating window controls — no dedicated titlebar strip. The drag regions
// live on the TopBar band and the sidebar header so the window chrome is
// invisible (like Spotify's frameless top area). This cluster overlays the
// top-right corner above every layer (NowPlaying is z-50).
export function TitleBar() {
  const t = useT()
  const [max, setMax] = useState(false)
  const bridge = window.freebify?.win

  useEffect(() => {
    const off = bridge?.onMaximized?.(setMax)
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!bridge) return null

  return (
    // sits over plain (non-app-region) space — the TopBar drag band stops
    // before this x-range so every click is a plain DOM event, no
    // app-region hit-test roundtrip through the renderer
    <div className="absolute right-0 top-0 z-[60] flex h-12 items-stretch">
      <button
        onClick={() => bridge.control("minimize")}
        aria-label={t("win.minimize")}
        title={t("win.minimize")}
        className="no-drag grid w-11 place-items-center text-dim transition hover:bg-hover hover:text-ink"
      >
        <Minus size={16} />
      </button>
      <button
        onClick={() => bridge.control("maximize")}
        aria-label={max ? t("win.restore") : t("win.maximize")}
        title={max ? t("win.restore") : t("win.maximize")}
        className="no-drag grid w-11 place-items-center text-dim transition hover:bg-hover hover:text-ink"
      >
        {max ? <Copy size={13} /> : <Square size={13} />}
      </button>
      <button
        onClick={() => bridge.control("close")}
        aria-label={t("win.close")}
        title={t("win.closeToTray")}
        className="no-drag grid w-11 place-items-center rounded-tr-none text-dim transition hover:bg-red-600 hover:text-white"
      >
        <X size={17} />
      </button>
    </div>
  )
}
