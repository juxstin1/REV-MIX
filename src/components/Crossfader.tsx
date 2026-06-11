import { useCallback, useEffect, useRef, useState } from "react";

interface CrossfaderProps {
  value: number; // 0 = A, 1 = B
  onChange: (v: number) => void;
}

/** Horizontal crossfader with A/B end labels. */
export function Crossfader({ value, onChange }: CrossfaderProps) {
  const [dragging, setDragging] = useState(false);
  const laneRef = useRef<HTMLDivElement>(null);

  const setFromX = useCallback(
    (clientX: number) => {
      const lane = laneRef.current;
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      const v = (clientX - rect.left) / rect.width;
      onChange(Math.max(0, Math.min(1, v)));
    },
    [onChange]
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setFromX(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, setFromX]);

  return (
    <div className="xfader-block">
      <span className="xfader-end">A</span>
      <div
        className="xfader"
        ref={laneRef}
        onPointerDown={(e) => {
          setFromX(e.clientX);
          setDragging(true);
        }}
      >
        <div className="xfader-slot" />
        {Array.from({ length: 7 }, (_, i) => (
          <i key={i} className="xfader-mark" style={{ left: `${(i / 6) * 100}%` }} />
        ))}
        <div className={`xfader-cap${dragging ? " grabbed" : ""}`} style={{ left: `calc(${value * 100}% - 16px)` }}>
          <i />
        </div>
      </div>
      <span className="xfader-end">B</span>
    </div>
  );
}
