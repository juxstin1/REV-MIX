import { useEffect, useRef, useState } from "react";

const SEGMENTS = 14;

interface VUMeterProps {
  /** returns RMS 0..1 */
  getLevel: () => number;
}

/** LED segment meter, club-mixer style: green → amber → red. */
export function VUMeter({ getLevel }: VUMeterProps) {
  const [lit, setLit] = useState(0);
  const peak = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const rms = getLevel();
      // map rms (~0..0.5 typical) to segments with soft log curve
      const db = 20 * Math.log10(Math.max(1e-4, rms));
      const norm = Math.max(0, Math.min(1, (db + 42) / 42));
      const target = norm * SEGMENTS;
      peak.current = Math.max(target, peak.current * 0.93);
      setLit(peak.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getLevel]);

  return (
    <div className="vu-meter">
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const idx = SEGMENTS - 1 - i; // top first
        const on = lit >= idx + 0.5;
        const zone = idx >= SEGMENTS - 2 ? "red" : idx >= SEGMENTS - 5 ? "amber" : "green";
        return <i key={i} className={`vu-led ${zone}${on ? " on" : ""}`} />;
      })}
    </div>
  );
}
