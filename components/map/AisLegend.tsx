/**
 * AisLegend — Floating glass-pill legend + Guard Zone toggle.
 *
 * Renders a compact, horizontally scrollable strip along the bottom
 * of the map. Only visible when AIS layers are active.
 * Includes a shield icon toggle for the AIS Guard Zone.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { AisGuardZone, type GuardZoneState } from '../../services/AisGuardZone';
import { triggerHaptic } from '../../utils/system';

const STATUS_ITEMS: { color: string; label: string }[] = [
    { color: '#22c55e', label: 'Underway' },
    { color: '#f59e0b', label: 'Anchored' },
    { color: '#94a3b8', label: 'Moored' },
    { color: '#06b6d4', label: 'Fishing' },
    { color: '#38bdf8', label: 'Class B' },
    { color: '#f97316', label: 'Restricted' },
    { color: '#ef4444', label: 'NUC / Aground' },
];

const RADIUS_OPTIONS = [0.5, 1, 2, 5, 10];

interface AisLegendProps {
    visible: boolean;
}

export const AisLegend: React.FC<AisLegendProps> = ({ visible }) => {
    const [guardState, setGuardState] = useState<GuardZoneState>(AisGuardZone.getState());
    const [showRadiusPicker, setShowRadiusPicker] = useState(false);

    useEffect(() => AisGuardZone.subscribe(setGuardState), []);

    const toggleGuard = useCallback(() => {
        triggerHaptic('medium');
        AisGuardZone.setEnabled(!guardState.enabled);
    }, [guardState.enabled]);

    const selectRadius = useCallback((r: number) => {
        triggerHaptic('light');
        AisGuardZone.setRadius(r);
        setShowRadiusPicker(false);
    }, []);

    if (!visible) return null;

    return (
        <>
            <div
                style={{
                    position: 'absolute',
                    bottom: 28,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 400,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 14px',
                    background: 'rgba(15, 23, 42, 0.85)',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: 20,
                    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.4)',
                    whiteSpace: 'nowrap',
                    animation: 'aisLegendIn 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
                }}
            >
                {/* Guard Zone Shield Toggle */}
                <button
                    aria-label="Guard"
                    onClick={toggleGuard}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        setShowRadiusPicker((p) => !p);
                    }}
                    onDoubleClick={() => setShowRadiusPicker((p) => !p)}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '3px 8px',
                        borderRadius: 12,
                        border: `1px solid ${guardState.enabled ? 'rgba(239, 68, 68, 0.4)' : 'rgba(255,255,255,0.06)'}`,
                        background: guardState.enabled ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
                        cursor: 'pointer',
                        transition: 'all 200ms ease',
                    }}
                    title={`Guard Zone ${guardState.enabled ? 'ON' : 'OFF'} — ${guardState.radiusNm} NM (double-tap to change radius)`}
                >
                    <span style={{ fontSize: 12 }}>🛡️</span>
                    <span
                        style={{
                            fontSize: 9,
                            fontWeight: 800,
                            color: guardState.enabled ? '#fca5a5' : '#64748b',
                            letterSpacing: 0.3,
                            fontFamily: '-apple-system, system-ui, sans-serif',
                        }}
                    >
                        {guardState.radiusNm} NM
                    </span>
                </button>

                {/* Divider */}
                <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)' }} />

                {/* Status colour dots */}
                {STATUS_ITEMS.map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: color,
                                boxShadow: `0 0 5px ${color}80`,
                                flexShrink: 0,
                            }}
                        />
                        <span
                            style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: '#94a3b8',
                                letterSpacing: 0.2,
                                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                            }}
                        >
                            {label}
                        </span>
                    </div>
                ))}
            </div>

            {/* Radius picker popover */}
            {showRadiusPicker && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 62,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 401,
                        display: 'flex',
                        gap: 6,
                        padding: '6px 10px',
                        background: 'rgba(15, 23, 42, 0.95)',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: 14,
                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
                        animation: 'aisLegendIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
                    }}
                >
                    {RADIUS_OPTIONS.map((r) => (
                        <button
                            aria-label="Radius"
                            key={r}
                            onClick={() => selectRadius(r)}
                            style={{
                                padding: '4px 10px',
                                borderRadius: 10,
                                border: 'none',
                                background:
                                    r === guardState.radiusNm ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255,255,255,0.05)',
                                color: r === guardState.radiusNm ? '#fca5a5' : '#94a3b8',
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: 'pointer',
                                fontFamily: 'monospace',
                            }}
                        >
                            {r} NM
                        </button>
                    ))}
                </div>
            )}
        </>
    );
};
