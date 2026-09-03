/**
 * Anchor swing arc for the Nav Station hero band.
 */
import React from 'react';

/** Anchor swing arc — circular SVG showing the alarm radius AND
 *  the vessel's actual position relative to the anchor point.
 *
 *  Pass 4 had a static "swing radius circle". Pass 5 plots the
 *  vessel dot at its real bearing/offset — so a skipper glancing
 *  at the hero band can see "I'm at 35m to the south-east, my
 *  alarm is at 50m". The arc speaks the same language as a real
 *  electronic anchor display.
 *
 *  - Center cross   = anchor point
 *  - Outer dashed   = alarm radius (pre-set swing)
 *  - Inner faint    = ½ alarm radius reference
 *  - Vessel dot     = current position (bearing + offset)
 *  - Track line     = anchor → vessel (visual indicator of drift)
 *  - On alarm: whole arc pulses red. */
export const SwingArc: React.FC<{
    radiusM: number;
    offsetM: number;
    bearingDeg: number;
    alarm: boolean;
}> = ({ radiusM, offsetM, bearingDeg, alarm }) => {
    const size = 44;
    const cx = size / 2;
    const cy = size / 2;
    const ringR = size / 2 - 3;
    const color = alarm ? '#ef4444' : '#22d3ee';

    // Plot vessel: bearing 0° = north (top of arc). Map polar
    // (bearing, ratio) → cartesian. Clamp ratio just past 1 so a
    // dragging boat visibly sits beyond the alarm ring.
    const safeRadius = Math.max(radiusM, 1);
    const ratio = Math.min(offsetM / safeRadius, 1.05);
    const r = ringR * ratio;
    const angleRad = ((bearingDeg - 90) * Math.PI) / 180;
    const vx = cx + r * Math.cos(angleRad);
    const vy = cy + r * Math.sin(angleRad);

    return (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {/* Alarm boundary ring (dashed) */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={ringR}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.45}
                    strokeWidth={1.25}
                    strokeDasharray="2 3"
                />
                {/* Inner reference ring at ½ alarm radius */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={ringR * 0.5}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.22}
                    strokeWidth={1}
                />
                {/* Anchor — center cross */}
                <line x1={cx - 2.5} y1={cy} x2={cx + 2.5} y2={cy} stroke={color} strokeOpacity={0.7} strokeWidth={1} />
                <line x1={cx} y1={cy - 2.5} x2={cx} y2={cy + 2.5} stroke={color} strokeOpacity={0.7} strokeWidth={1} />
                {/* Track line from anchor to vessel */}
                {offsetM > 1 && (
                    <line x1={cx} y1={cy} x2={vx} y2={vy} stroke={color} strokeOpacity={0.4} strokeWidth={0.8} />
                )}
                {/* Vessel dot — actual offset position */}
                <circle cx={vx} cy={vy} r={2.5} fill={color} />
            </svg>
            <div
                className="absolute inset-0 flex items-end justify-center pointer-events-none"
                style={{ paddingBottom: 1 }}
            >
                <span className="text-[9px] font-mono font-bold leading-none tabular-nums" style={{ color }}>
                    {Math.round(radiusM)}m
                </span>
            </div>
            {alarm && (
                <div
                    className="absolute inset-0 rounded-full pointer-events-none"
                    style={{ animation: 'pulse 1s infinite', boxShadow: '0 0 12px rgba(239,68,68,0.5)' }}
                />
            )}
        </div>
    );
};
