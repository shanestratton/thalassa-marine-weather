/**
 * CompassRoseOverlay — the route tracer's compass rose.
 *
 * Cardinal marks are passed on the side they NAME (a north cardinal →
 * pass NORTH of it). That's easy on a paper chart, hard on a phone —
 * so while tracing, this rose sits over the chart to read off which
 * side is which (Shane 2026-07-11). The whole card counter-rotates
 * with the map bearing, so the N arm always points at true north ON
 * SCREEN even if the chart isn't north-up.
 *
 * LOCKED top-left, centred on the plotting card (Shane 2026-07-15:
 * "lock the compass in the top left position, dead centre of the
 * plotting card") — the draggable-hand-tool era ended when the drift
 * kept parking it over chart the punter was reading. Screen-anchored,
 * not geo-anchored.
 */

import React, { useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

/** Rendered size of the rose card in px (square). */
const SIZE = 116;
/** The tracer card: absolute left-3 (12 px), w-72 (288 px). The rose
 *  centres on the card's vertical axis: 12 + 288/2 − SIZE/2. */
const LOCKED_LEFT = 12 + 288 / 2 - SIZE / 2;

interface CompassRoseOverlayProps {
    mapRef: React.RefObject<mapboxgl.Map | null>;
    mapReady: boolean;
}

export const CompassRoseOverlay: React.FC<CompassRoseOverlayProps> = ({ mapRef, mapReady }) => {
    const [bearing, setBearing] = useState(() => mapRef.current?.getBearing() ?? 0);

    // Counter-rotate with the map so the arms stay honest.
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        const sync = () => setBearing(map.getBearing());
        sync();
        map.on('rotate', sync);
        return () => {
            map.off('rotate', sync);
        };
    }, [mapRef, mapReady]);

    return (
        <div
            role="img"
            aria-label="Compass rose — shows which side of the chart is north"
            className="fixed z-[9996] select-none"
            style={{
                left: LOCKED_LEFT,
                top: 'calc(0.5rem + env(safe-area-inset-top))',
                width: SIZE,
                height: SIZE,
            }}
        >
            <svg
                viewBox="0 0 120 120"
                width={SIZE}
                height={SIZE}
                style={{
                    transform: `rotate(${-bearing}deg)`,
                    filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.55))',
                }}
            >
                {/* Card — LESS opaque (Shane 2026-07-17: reverted "more opaque",
                    now wants it lighter than the original): 0.85 → 0.40 fill so
                    the chart shows through the rose. */}
                <circle
                    cx="60"
                    cy="60"
                    r="57"
                    fill="rgba(4,14,24,0.40)"
                    stroke="rgba(255,255,255,0.4)"
                    strokeWidth="1.5"
                />
                <circle cx="60" cy="60" r="44" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
                {/* Intercardinal arms (shorter, muted) */}
                {[45, 135, 225, 315].map((a) => (
                    <path
                        key={a}
                        d="M60 32 L64 55 L60 60 L56 55 Z"
                        fill="rgba(148,163,184,0.75)"
                        transform={`rotate(${a} 60 60)`}
                    />
                ))}
                {/* Cardinal arms — N red, the rest bone-white */}
                {[
                    { a: 0, fill: '#ef4444' },
                    { a: 90, fill: '#e2e8f0' },
                    { a: 180, fill: '#e2e8f0' },
                    { a: 270, fill: '#e2e8f0' },
                ].map(({ a, fill }) => (
                    <path
                        key={a}
                        d="M60 20 L66 54 L60 60 L54 54 Z"
                        fill={fill}
                        stroke="rgba(2,10,18,0.7)"
                        strokeWidth="1"
                        transform={`rotate(${a} 60 60)`}
                    />
                ))}
                <circle cx="60" cy="60" r="3.5" fill="#e2e8f0" stroke="rgba(2,10,18,0.7)" strokeWidth="1" />
                {/* Letters ride the card like a real compass rose */}
                {[
                    { l: 'N', x: 60, y: 15, fill: '#f87171' },
                    { l: 'E', x: 106, y: 64.5, fill: '#e2e8f0' },
                    { l: 'S', x: 60, y: 113, fill: '#e2e8f0' },
                    { l: 'W', x: 14, y: 64.5, fill: '#e2e8f0' },
                ].map(({ l, x, y, fill }) => (
                    <text
                        key={l}
                        x={x}
                        y={y}
                        fill={fill}
                        fontSize="13"
                        fontWeight="900"
                        fontFamily="system-ui, sans-serif"
                        textAnchor="middle"
                        stroke="rgba(2,10,18,0.85)"
                        strokeWidth="2.5"
                        paintOrder="stroke"
                    >
                        {l}
                    </text>
                ))}
            </svg>
            {/* No dismiss ✕ (Shane 2026-07-15: "it is locked in position,
                we will never need to delete it") — the 🧭 toggle in the
                tracer panel header is the only show/hide control. */}
        </div>
    );
};
