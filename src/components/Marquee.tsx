import { motion } from "motion/react"
import { useEffect, useRef, useState } from "react"

export function Marquee({ text, className = "" }: { text: string; className?: string }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [dist, setDist] = useState(0)

  useEffect(() => {
    const measure = () => {
      const o = outer.current
      const i = inner.current
      if (o && i) setDist(Math.max(0, i.scrollWidth - o.clientWidth + 36))
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (outer.current) ro.observe(outer.current)
    if (inner.current) ro.observe(inner.current)
    return () => ro.disconnect()
  }, [text])

  return (
    <div ref={outer} className={`overflow-hidden whitespace-nowrap ${className}`}>
      <motion.span
        ref={inner}
        className="inline-block will-change-transform"
        animate={dist > 0 ? { x: [0, -dist] } : { x: 0 }}
        transition={
          dist > 0
            ? { duration: dist / 26, repeat: Infinity, repeatType: "mirror", ease: "linear", repeatDelay: 1.4 }
            : undefined
        }
      >
        {text}
      </motion.span>
    </div>
  )
}
