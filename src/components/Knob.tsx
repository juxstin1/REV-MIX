import { useCallback, useEffect, useRef, useState } from "react";

interface KnobProps {
  label: string;
  value: number; // 0..1
  onChange: (v: number) => void;
  /** detent at centre (EQ-style knobs) */
  centerDetent?: boolean;
  size?: number;
  accent?: string;
  /** render the label above the dial instead of below */
  labelTop?: boolean;
}

/**
 * Skeuomorphic rotary knob — drag vertically to turn, double-click to
 * reset. Sweep is 270° like real mixer pots, with a glowing position
 * indicator and machined-metal cap.
 */
export function Knob({ label, value, onChange, centerDetent = false, size = 54, accent, labelTop = false }: KnobProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ startY: 0, startV: 0 });

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { startY: e.clientY, startV: value };
      setDragging(true);
    },
    [value]
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const dy = drag.current.startY - e.clientY;
      let v = drag.current.startV + dy / 160;
      v = Math.max(0, Math.min(1, v));
      if (centerDetent && Math.abs(v - 0.5) < 0.035) v = 0.5;
      onChange(v);
    };
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, centerDetent, onChange]);

  const angle = -135 + value * 270;
  const atCenter = centerDetent && Math.abs(value - 0.5) < 0.001;

  return (
    <div className={`knob-unit${labelTop ? " label-top" : ""}`} style={accent ? ({ "--knob-accent": accent } as React.CSSProperties) : undefined}>
      <div className="knob-ring">
        {/* tick marks around the sweep */}
        {Array.from({ length: 11 }, (_, i) => (
          <i
            key={i}
            className={`knob-tick${i === 5 ? " mid" : ""}`}
            style={{ transform: `rotate(${-135 + i * 27}deg)` }}
          />
        ))}
        <div
          className={`knob-cap${dragging ? " grabbed" : ""}${atCenter ? " detent" : ""}`}
          style={{ width: size, height: size }}
          onPointerDown={onPointerDown}
          onDoubleClick={() => onChange(0.5)}
        >
          <div className="knob-grip" style={{ transform: `rotate(${angle}deg)` }}>
            <span className="knob-pointer" />
          </div>
        </div>
      </div>
      <span className="knob-label">{label}</span>
    </div>
  );
}
