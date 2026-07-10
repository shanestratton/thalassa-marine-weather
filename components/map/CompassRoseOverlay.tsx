/**
 * CompassRoseOverlay — a draggable compass rose for the route tracer.
 *
 * Cardinal marks are passed on the side they NAME (a north cardinal →
 * pass NORTH of it). That's easy on a paper chart, hard on a phone —
 * so while tracing, this rose floats over the chart and can be dragged
 * right up beside the mark in question to read off which side is
 * which (Shane 2026-07-11). The whole card counter-rotates with the
 * map bearing, so the N arm always points at true north ON SCREEN
 * even if the chart isn't north-up.
 *
 * Screen-anchored (not geo-anchored): it's a hand tool, not a map
 * feature. Position persists across sessions per device.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

const POS_KEY = 'thalassa_compass_rose_pos';
/** Rendered size of the rose card in px (square). */
const SIZE = 116;
const EDGE = 6;

interface CompassRoseOverlayProps {
    mapRef: React.RefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    onClose: () => void;
}

function clampPos(x: number, y: number): { x: number; y: number } {
    return {
        x: Math.min(Math.max(x, EDGE), window.innerWidth - SIZE - EDGE),
        y: Math.min(Math.max(y, EDGE), window.innerHeight - SIZE - EDGE),
    };
}

function initialPos(): { x: number; y: number } {
    try {
        const raw = localStorage.getItem(POS_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            if (typeof p?.x === 'number' && typeof p?.y === 'number') return clampPos(p.x, p.y);
        }
    } catch {
        /* fall through to default */
    }
    // Default: upper-right, clear of the tracer panel (bottom-left)
    // and the chart-mode buttons (top-left).
    return clampPos(window.innerWidth - SIZE - 12, window.innerHeight * 0.24);
}

export const CompassRoseOverlay: React.FC<CompassRoseOverlayProps> = ({ mapRef, mapReady, onClose }) => {
    const [pos, setPos] = useState(initialPos);
    const [bearing, setBearing] = useState(() => mapRef.current?.getBearing() ?? 0);
    const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

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

    // Keep the rose on-screen through rotations/resizes.
    useEffect(() => {
        const onResize = () => setPos((p) => clampPos(p.x, p.y));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const onPointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            dragRef.current = { pointerId: e.pointerId, dx: e.clientX - pos.x, dy: e.clientY - pos.y };
            e.currentTarget.setPointerCapture(e.pointerId);
        },
        [pos.x, pos.y],
    );

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        setPos(clampPos(e.clientX - drag.dx, e.clientY - drag.dy));
    }, []);

    const onPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId !== e.pointerId) return;
        dragRef.current = null;
        setPos((p) => {
            try {
                localStorage.setItem(POS_KEY, JSON.stringify(p));
            } catch {
                /* storage full — position just won't persist */
            }
            return p;
        });
    }, []);

    return (
        <div
            role="img"
            aria-label="Compass rose — drag beside a cardinal mark to see which side is north"
            className="fixed z-[9996] select-none"
            style={{
                left: pos.x,
                top: pos.y,
                width: SIZE,
                height: SIZE,
                touchAction: 'none',
                cursor: 'grab',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
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
                {/* Card */}
                <circle
                    cx="60"
                    cy="60"
                    r="57"
                    fill="rgba(4,14,24,0.62)"
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
            {/* Dismiss — the 🧭 button in the tracer panel brings it back */}
            <button
                aria-label="Hide compass rose"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onClose}
                className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/20 bg-slate-800 text-[10px] font-bold text-gray-300 shadow"
            >
                ✕
            </button>
        </div>
    );
};
