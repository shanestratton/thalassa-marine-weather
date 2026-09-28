import React from 'react';
import type { DayPlanOption } from '../../services/dayPlanner/engine';

/** A deliberately labelled outline, never a chart or clearance overlay. */
export function DayPlanOutline({ option }: { option: DayPlanOption }) {
    const points = option.legs.flatMap((leg) => leg.route.coordinates);
    if (points.length < 2) return null;
    const lat0 = (points[0][1] * Math.PI) / 180;
    const xy = points.map(([lon, lat]) => [lon * Math.cos(lat0), -lat]);
    const minX = Math.min(...xy.map(([x]) => x));
    const minY = Math.min(...xy.map(([, y]) => y));
    const scale = Math.min(
        240 / Math.max(0.00001, Math.max(...xy.map(([x]) => x)) - minX),
        88 / Math.max(0.00001, Math.max(...xy.map(([, y]) => y)) - minY),
    );
    const project = ([lon, lat]: [number, number]) => [
        30 + (lon * Math.cos(lat0) - minX) * scale,
        18 + (-lat - minY) * scale,
    ];
    const start = project(points[0]);
    const stop = project(option.legs[0].route.coordinates.at(-1)!);
    return (
        <figure className="day-plan-outline">
            <svg
                viewBox="0 0 300 128"
                role="img"
                aria-label={`Calculated route outline to ${option.candidate.destination.name}; not a chart`}
            >
                {option.legs.map((leg, i) => (
                    <polyline
                        key={i}
                        points={leg.route.coordinates.map((p) => project(p).join(',')).join(' ')}
                        fill="none"
                        stroke={i ? '#67e8f9' : '#c084fc'}
                        strokeWidth="3"
                        strokeLinejoin="round"
                    />
                ))}
                <circle cx={start[0]} cy={start[1]} r="5" fill="#67e8f9" stroke="#0f172a" strokeWidth="2" />
                <circle cx={stop[0]} cy={stop[1]} r="5" fill="#fcd34d" stroke="#0f172a" strokeWidth="2" />
            </svg>
            <figcaption>Route outline · open the chart to review</figcaption>
        </figure>
    );
}
