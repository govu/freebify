import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  /** optional key — change it to reset the boundary after a retry */
  resetKey?: string
}

interface State {
  crashed: boolean
}

// One render-time throw anywhere (malformed API data, a bad persisted
// blob…) used to unmount the ENTIRE app to a black window. Contain the
// damage to a recoverable panel instead.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false }

  static getDerivedStateFromError(): State {
    return { crashed: true }
  }

  componentDidCatch(err: unknown) {
    console.error("[freebify] render error", err)
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.crashed) {
      this.setState({ crashed: false })
    }
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return (
      <div className="grid min-h-[60vh] place-items-center p-10 text-center">
        <div>
          <p className="text-lg font-bold">Something went wrong</p>
          <p className="mt-2 text-sm text-dim">
            This view crashed. Your music and playlists are safe — try again.
          </p>
          <button
            onClick={() => {
              this.setState({ crashed: false })
              // HashRouter reads the hash; dev BrowserRouter would just
              // reload the same crashing path — send it home instead
              if (window.location.protocol === "file:") {
                window.location.hash = "#/"
                window.location.reload()
              } else {
                window.location.href = "/"
              }
            }}
            className="mt-5 rounded-full bg-ink px-5 py-2 text-sm font-semibold text-black transition hover:scale-105"
          >
            Reload Freebify
          </button>
        </div>
      </div>
    )
  }
}
