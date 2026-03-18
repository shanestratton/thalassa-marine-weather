/**
 * AisGuardAlert — Toast notification for AIS guard zone intrusions.
 *
 * Listens for 'ais-guard-alert' custom events and shows a slide-in
 * alert card at the top of the screen. Auto-dismisses after 8 seconds.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { GuardAlert } from '../../services/AisGuardZone';

export const AisGuardAlert: React.FC = () => {
    const [alerts, setAlerts] = useState<GuardAlert[]>([]);

    useEffect(() => {
        const handler = (e: Event) => {
            const newAlerts = (e as CustomEvent<GuardAlert[]>).detail;
            setAlerts((prev) => [...newAlerts, ...prev].slice(0, 5));
        };
        window.addEventListener('ais-guard-alert', handler);
        return () => window.removeEventListener('ais-guard-alert', handler);
    }, []);

    // Auto-dismiss after 8s
    useEffect(() => {
        if (alerts.length === 0) return;
        const timer = setTimeout(() => {
            setAlerts((prev) => prev.slice(0, -1));
        }, 8000);
        return () => clearTimeout(timer);
    }, [alerts]);

    const dismiss = useCallback((mmsi: number) => {
        setAlerts((prev) => prev.filter((a) => a.mmsi !== mmsi));
    }, []);

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
                    onClick={() => dismiss(alert.mmsi)}
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
                        cursor: 'pointer',
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
                            <div style={{ fontSize: 10, color: '#fca5a5', opacity: 0.7 }}>
                                {alert.bearing}° • {alert.sog.toFixed(1)} kn
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};
