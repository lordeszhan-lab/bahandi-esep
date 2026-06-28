"use client";

/**
 * useCountUp — animate a number from its previous value to the target.
 *
 * The only joy the Tower permits (СВЕРКА joy-matrix: "KPI-числа на любых
 * дашбордах — только count-up"). Reads as premium-fintech, not playful. Eases
 * out over ~800 ms; on filter/window changes it animates from the current value
 * to the new one so the numbers settle rather than snap. `prefers-reduced-motion`
 * jumps straight to the target.
 */
import { useEffect, useRef, useState } from "react";

export function useCountUp(target: number, durationMs = 800): number {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce || durationMs <= 0) {
      setValue(target);
      fromRef.current = target;
      return;
    }

    const from = fromRef.current;
    const start = performance.now();
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setValue(from + (target - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return value;
}
