/**
 * RouteLegend — Glassmorphism floating legend for passage route lines.
 *
 * Matches the visual language of ThalassaHelixControl / LegendDock
 * (vertical pill, glass background, compact typography).
 *
 * Shows during passage mode once a route is computed:
 *   🟢 GFS Route (primary weather-routed track)
 *   🩷 ECMWF Confidence (multi-model comparison)
 *   ⬛ Harbour (navigate-yourself dashed legs)
 */

import React, { memo } from 'react';

interface RouteLegendEntry {
    color: string;
    label: string;
    dashed?: boolean;
    glowColor?: string;
}

const ROUTE_LEGEND: RouteLegendEntry[] = [
    { color: '#00e676', label: 'GFS Route', glowColor: 'rgba(0,230,118,0.4)' },
    { color: '#e879f9', label: 'ECMWF', glowColor: 'rgba(232,121,249,0.4)' },
    { color: '#38bdf8', label: 'Harbour', dashed: true },
];

interface RouteLegendProps {
    visible: boolean;
    embedded?: boolean;
}

export const RouteLegend: React.FC<RouteLegendProps> = memo(({ visible, embedded }) => {
    if (!visible) return null;

    return (
        <div
            className="absolute z-[500] animate-in fade-in slide-in-from-left-2 duration-300"
            style={{
                left: 12,
                bottom: embedded ? 12 : 'calc(80px + env(safe-area-inset-bottom))',
            }}
        >
            <div
                style={{
                    background: 'rgba(15, 23, 42, 0.75)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 14,
                    padding: '10px 12px',
                }}
            >
                {/* Title */}
                <div
                    style={{
                        fontSize: 9,
                        fontWeight: 800,
                        color: 'rgba(255,255,255,0.35)',
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        marginBottom: 6,
                    }}
                >
                    Route
                </div>

                {/* Legend entries */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {ROUTE_LEGEND.map((entry) => (
                        <div key={entry.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {/* Colour swatch */}
                            <div
                                style={{
                                    width: 18,
                                    height: 3,
                                    borderRadius: 2,
                                    background: entry.color,
                                    boxShadow: entry.glowColor ? `0 0 6px ${entry.glowColor}` : 'none',
                                    ...(entry.dashed
                                        ? {
                                              background: `repeating-linear-gradient(90deg, ${entry.color} 0px, ${entry.color} 4px, transparent 4px, transparent 7px)`,
                                              boxShadow: 'none',
                                              border: 'none',
                                          }
                                        : {}),
                                }}
                            />
                            {/* Label */}
                            <span
                                style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    color: 'rgba(255,255,255,0.6)',
                                    letterSpacing: '0.02em',
                                    lineHeight: 1,
                                }}
                            >
                                {entry.label}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
});

RouteLegend.displayName = 'RouteLegend';
