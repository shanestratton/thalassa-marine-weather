/**
 * AisGuardAlert — a vessel has entered the guard ring.
 *
 * NOT A TOAST, deliberately. This used to slide in and delete itself after
 * eight seconds, and a tap anywhere on the card dismissed it — so a stray
 * touch while panning the chart, or simply looking away, silently discarded
 * a collision warning. The one class of message that must never vanish on a
 * timer is the one telling you something is close.
 *
 * It now stays until explicitly acknowledged, per this project's standing
 * rule that anything the skipper must act on gets a surface that holds still
 * (Shane, twice: "i hate toast messages"). Transient status may be a toast;
 * a proximity alarm may not.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { GuardAlert } from '../../services/AisGuardZone';
import { AisGuardAlertStore } from '../../services/aisGuardAlertStore';

export const AisGuardAlert: React.FC = () => {
    // Read from the STORE, not the window event. Owning the list here meant an
    // alert raised on another page was heard by nobody, and coming back to the
    // chart replayed nothing — while AisGuardZone, being edge-triggered, would
    // not raise it again for a vessel that never left the ring.
    const [alerts, setAlerts] = useState<GuardAlert[]>(() => AisGuardAlertStore.get());
    useEffect(() => AisGuardAlertStore.subscribe(setAlerts), []);

    const dismiss = useCallback((mmsi: number) => AisGuardAlertStore.dismiss(mmsi), []);

    if (alerts.length === 0) return null;

    return (
        <div
            style={{
                position: 'fixed',
                top: 'calc(env(safe-area-inset-top, 0px) + 60px)',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 9000,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                width: '90vw',
                maxWidth: 360,
                pointerEvents: 'auto',
            }}
        >
            {alerts.map((alert) => (
                <div
                    key={`${alert.mmsi}-${alert.timestamp}`}
                    role="alert"
                    style={{
                        background: 'rgba(127, 29, 29, 0.92)',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        border: '1px solid rgba(239, 68, 68, 0.4)',
                        borderRadius: 14,
                        padding: '12px 16px',
                        color: '#fecaca',
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                        boxShadow: '0 8px 32px rgba(239, 68, 68, 0.3)',
                        animation: 'guardAlertIn 400ms cubic-bezier(0.16, 1, 0.3, 1) both',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 18 }}>🛡️</span>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 800, color: '#fca5a5', letterSpacing: 0.5 }}>
                                GUARD ZONE ALERT
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: '#fee2e2', marginTop: 2 }}>
                                {alert.name}
                            </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: 16, fontWeight: 800, color: '#fca5a5', fontFamily: 'monospace' }}>
                                {alert.distanceNm.toFixed(1)} NM
                            </div>
                            {/* Bearing and speed of a target inside the guard
                                ring are the two numbers the skipper acts on —
                                they read at the size of the vessel name, not
                                below it. Inline fontSize is out of reach of the
                                CSS legibility floor. */}
                            <div style={{ fontSize: 13, color: '#fca5a5', opacity: 0.9 }}>
                                {alert.bearing}° • {alert.sog.toFixed(1)} kts
                            </div>
                        </div>
                        {/* The only way out. 44x44 so it is hittable on a
                            moving boat, and separated from the card body so
                            acknowledging is deliberate rather than accidental. */}
                        <button
                            type="button"
                            onClick={() => dismiss(alert.mmsi)}
                            aria-label={`Acknowledge guard alert for ${alert.name}`}
                            style={{
                                minWidth: 44,
                                minHeight: 44,
                                marginRight: -8,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'transparent',
                                border: 'none',
                                color: '#fecaca',
                                fontSize: 18,
                                lineHeight: 1,
                                cursor: 'pointer',
                            }}
                        >
                            ✕
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
};
