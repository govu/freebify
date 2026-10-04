// latin-only Inter faces are declared in index.css — the full package would
// bundle cyrillic/greek/vietnamese woff2s this app never renders
import { MotionConfig } from "motion/react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, HashRouter } from "react-router-dom"
import App from "./App.tsx"
import { ytEngine } from "./api/ytplayer"
import "./index.css"

// file:// (packaged Electron) can't use history routing — hash router there.
const Router = window.location.protocol === "file:" ? HashRouter : BrowserRouter

// Warm the hidden YouTube engine so the first play doesn't pay API load time
if (window.location.protocol === "file:") ytEngine.warmup()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <Router>
        <App />
      </Router>
    </MotionConfig>
  </StrictMode>,
)
