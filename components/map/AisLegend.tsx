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
import { AIS_LEGEND_ITEMS } from './aisPresentationPalette';

const RADIUS_OPTIONS = [0.5, 1, 2, 5, 10];

interface AisLegendProps {
    visible: boolean;
    /** Inline in a shared chart key, retaining the same guard controls. */
    embedded?: boolean;
}

export const AisLegend: React.FC<AisLegendProps> = ({ visible, embedded = false }) => {
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
                role="group"
                aria-label="AIS vessel colours and guard controls"
                style={{
                    position: embedded ? 'static' : 'absolute',
                    bottom: embedded ? undefined : 'calc(28px + env(safe-area-inset-bottom, 0px))',
                    left: embedded ? undefined : '50%',
                    transform: embedded ? undefined : 'translateX(-50%)',
                    zIndex: embedded ? undefined : 400,
                    display: 'flex',
                    flexWrap: embedded ? 'wrap' : 'nowrap',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 14px',
                    background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.85))',
                    backdropFilter: 'blur(16px)',
                    WebkitBackdropFilter: 'blur(16px)',
                    border: '1px solid var(--day-ui-border, rgba(255, 255, 255, 0.08))',
                    borderRadius: 20,
                    boxShadow: 'var(--day-ui-shadow, 0 4px 24px rgba(0, 0, 0, 0.4))',
                    whiteSpace: embedded ? 'normal' : 'nowrap',
                    maxWidth: embedded ? '100%' : 'calc(100vw - 24px)',
                    overflowX: embedded ? undefined : 'auto',
                    overscrollBehaviorX: 'contain',
                    WebkitOverflowScrolling: 'touch',
                    scrollbarWidth: 'none',
                    animation: embedded ? undefined : 'aisLegendIn 300ms cubic-bezier(0.16, 1, 0.3, 1) both',
                }}
            >
                {/* Guard Zone Shield Toggle */}
                <button
                    type="button"
                    aria-label={`${guardState.enabled ? 'Disable' : 'Enable'} AIS guard zone`}
                    aria-pressed={guardState.enabled}
                    className="hit-target-44"
                    /* The double-click handler is GONE. It shared this button with onClick,
                       so a double-tap toggled the guard ON then OFF on its way to opening
                       the radius picker — a picker that has its own button right beside this
                       one (audit 2026-09-02). The toggle stays immediate: a guard-zone
                       switch must not lag by a double-tap window. Long-press (contextmenu)
                       still opens the picker. */
                    onClick={toggleGuard}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        setShowRadiusPicker((p) => !p);
                    }}
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
                    title={`Guard Zone ${guardState.enabled ? 'ON' : 'OFF'} — ${guardState.radiusNm} NM. Use the arrow to change radius.`}
                >
                    <span style={{ fontSize: 12 }}>🛡️</span>
                    <span
                        style={{
                            fontSize: 12,
                            fontWeight: 800,
                            color: guardState.enabled
                                ? 'var(--day-ui-danger, #fca5a5)'
                                : 'var(--day-ui-muted, #64748b)',
                            letterSpacing: 0.3,
                            fontFamily: '-apple-system, system-ui, sans-serif',
                        }}
                    >
                        {guardState.radiusNm} NM
                    </span>
                </button>
                <button
                    type="button"
                    aria-label="Choose AIS guard zone radius"
                    aria-expanded={showRadiusPicker}
                    className="hit-target-44"
                    onClick={() => setShowRadiusPicker((open) => !open)}
                    style={{
                        width: 28,
                        height: 28,
                        borderRadius: 12,
                        border: '1px solid var(--day-ui-border, rgba(255,255,255,0.08))',
                        background: showRadiusPicker ? 'rgba(56,189,248,0.15)' : 'transparent',
                        color: showRadiusPicker ? 'var(--day-ui-accent, #7dd3fc)' : 'var(--day-ui-muted, #64748b)',
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                >
                    ▾
                </button>

                {/* Divider */}
                <div
                    style={{ width: 1, height: 14, background: 'var(--day-ui-surface-soft, rgba(255,255,255,0.08))' }}
                />

                {/* Type colours, plus the navigation-danger override. */}
                {AIS_LEGEND_ITEMS.map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div
                            aria-hidden="true"
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
                                color: 'var(--day-ui-muted, #94a3b8)',
                                letterSpacing: 0.2,
                                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                            }}
                        >
                            {label}
                        </span>
                    </div>
                ))}
                <span style={{ fontSize: 10, color: 'var(--day-ui-muted, #94a3b8)' }}>
                    Boat: moving with known direction · Dot: stationary or direction unknown
                </span>
            </div>

            {/* Radius picker popover */}
            {showRadiusPicker && (
                <div
                    style={{
                        position: embedded ? 'static' : 'absolute',
                        bottom: embedded ? undefined : 'calc(62px + env(safe-area-inset-bottom, 0px))',
                        left: embedded ? undefined : '50%',
                        transform: embedded ? undefined : 'translateX(-50%)',
                        zIndex: embedded ? undefined : 401,
                        display: 'flex',
                        flexWrap: embedded ? 'wrap' : 'nowrap',
                        gap: 6,
                        padding: '6px 10px',
                        background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.95))',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        border: '1px solid var(--day-ui-border, rgba(255, 255, 255, 0.1))',
                        borderRadius: 14,
                        boxShadow: 'var(--day-ui-shadow, 0 8px 32px rgba(0, 0, 0, 0.5))',
                        animation: embedded ? undefined : 'aisLegendIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
                    }}
                    role="group"
                    aria-label="AIS guard zone radius"
                >
                    {RADIUS_OPTIONS.map((r) => (
                        <button
                            type="button"
                            aria-label={`Set AIS guard zone radius to ${r} nautical miles`}
                            aria-pressed={r === guardState.radiusNm}
                            className="hit-target-44"
                            key={r}
                            onClick={() => selectRadius(r)}
                            style={{
                                padding: '4px 10px',
                                borderRadius: 10,
                                border: 'none',
                                background:
                                    r === guardState.radiusNm
                                        ? 'rgba(239, 68, 68, 0.3)'
                                        : 'var(--day-ui-surface-soft, rgba(255,255,255,0.05))',
                                color:
                                    r === guardState.radiusNm
                                        ? 'var(--day-ui-danger, #fca5a5)'
                                        : 'var(--day-ui-muted, #94a3b8)',
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
