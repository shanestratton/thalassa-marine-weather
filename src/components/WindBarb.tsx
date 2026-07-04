import React from 'react';

/**
 * Standard meteorological wind barb, drawn pointing UP (= wind FROM the
 * north). The caller rotates the whole marker by the wind-from bearing so
 * the staff points into the wind. Feathers read the speed:
 *   pennant (filled triangle) = 50 kt, full barb = 10 kt, half barb = 5 kt.
 * Calm (< 3 kt) renders as an open circle.
 *
 * Speed is rounded to the nearest 5 kt, per convention.
 */
export const WindBarb: React.FC<{ speedKt: number; color?: string }> = ({ speedKt, color = '#e2e8f0' }) => {
    const kt = Math.round((speedKt ?? 0) / 5) * 5;
    const x = 20;
    const top = 6;
    const bottom = 46;

    if (kt < 3) {
        return (
            <svg width={26} height={26} viewBox="0 0 40 52" aria-hidden>
                <circle cx={x} cy={26} r={5} fill="none" stroke={color} strokeWidth={2} />
            </svg>
        );
    }

    const feathers: React.ReactNode[] = [];
    let rem = kt;
    let y = top;
    const pennants = Math.floor(rem / 50);
    rem -= pennants * 50;
    const fulls = Math.floor(rem / 10);
    rem -= fulls * 10;
    const halves = Math.floor(rem / 5);

    for (let i = 0; i < pennants; i++) {
        feathers.push(<polygon key={`p${i}`} points={`${x},${y} ${x - 13},${y + 3} ${x},${y + 6}`} fill={color} />);
        y += 9;
    }
    for (let i = 0; i < fulls; i++) {
        feathers.push(<line key={`f${i}`} x1={x} y1={y} x2={x - 13} y2={y - 5} stroke={color} strokeWidth={2} />);
        y += 5;
    }
    if (halves > 0) {
        // A lone half-barb sits one notch in from the tip so it can't be
        // mistaken for the staff end.
        if (y === top) y += 5;
        feathers.push(<line key="h" x1={x} y1={y} x2={x - 7} y2={y - 3} stroke={color} strokeWidth={2} />);
    }

    return (
        <svg width={26} height={26} viewBox="0 0 40 52" aria-hidden>
            <line x1={x} y1={top} x2={x} y2={bottom} stroke={color} strokeWidth={2} strokeLinecap="round" />
            {feathers}
        </svg>
    );
};

/** Windy-style speed ramp for barb colour (knots). */
export function windBarbColor(kt: number): string {
    if (kt < 8) return '#38bdf8'; // sky — light
    if (kt < 16) return '#34d399'; // emerald — moderate
    if (kt < 23) return '#fbbf24'; // amber — fresh
    if (kt < 34) return '#fb923c'; // orange — strong
    return '#f87171'; // red — gale+
}
