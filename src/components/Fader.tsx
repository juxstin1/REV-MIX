import { useCallback, useEffect, useRef, useState } from "react";

interface FaderProps {
  value: number; // 0..1, 1 = top
  onChange: (v: number) => void;
  height?: number;
}

/** Vertical channel fader with a machined cap and lane markings. */
export function Fader({ value, onChange, height = 150 }: FaderProps) {
  const [dragging, setDragging] = useState(false);
  const laneRef = useRef<HTMLDivElement>(null);

  const setFromY = useCallback(
    (clientY: number) => {
      const lane = laneRef.current;
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      const v = 1 - (clientY - rect.top) / rect.height;
      onChange(Math.max(0, Math.min(1, v)));
    },
    [onChange]
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setFromY(e.clientY);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, setFromY]);

  return (
    <div
      className="fader"
      style={{ height }}
      ref={laneRef}
      onPointerDown={(e) => {
        setFromY(e.clientY);
        setDragging(true);
      }}
    >
      <div className="fader-lane">
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} className="fader-mark" style={{ bottom: `${(i / 8) * 100}%` }} />
        ))}
        <div className="fader-slot" />
        <div className={`fader-cap${dragging ? " grabbed" : ""}`} style={{ bottom: `calc(${value * 100}% - 11px)` }}>
          <i />
        </div>
      </div>
    </div>
  );
}
