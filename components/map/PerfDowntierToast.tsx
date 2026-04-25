/**
 * PerfDowntierToast — one-shot toast surfaced after PerfGuardian
 * downtiered the device on the previous session.
 *
 * The graphics-quality reduction was already applied at module load
 * (utils/deviceTier.ts read the new `low` / `mid` setting from
 * localStorage). This toast is purely informational so the user
 * isn't confused by a quieter chart screen — particle density
 * lowered, but the safety-critical data (lightning, threat banner,
 * cyclones) is unaffected.
 *
 * Auto-dismisses after 6 seconds. Tappable to dismiss early.
 */
import React, { useEffect, useState } from 'react';

interface PerfDowntierToastProps {
    visible: boolean;
}

export const PerfDowntierToast: React.FC<PerfDowntierToastProps> = ({ visible }) => {
    const [showing, setShowing] = useState(visible);

    useEffect(() => {
        if (!visible) return;
        setShowing(true);
        const t = setTimeout(() => setShowing(false), 6000);
        return () => clearTimeout(t);
    }, [visible]);

    if (!showing) return null;

    return (
        <div
            // Sits below the threat banner so they don't fight for the
            // top-center slot. Z above all map overlays.
            className="fixed left-1/2 -translate-x-1/2 z-[175] pointer-events-auto chart-chip-in"
            style={{ top: 'max(110px, calc(env(safe-area-inset-top) + 110px))' }}
            role="status"
            aria-live="polite"
            onClick={() => setShowing(false)}
        >
            <div
                className="flex items-start gap-2 max-w-[320px]"
                style={{
                    background: 'rgba(15, 23, 42, 0.92)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    borderRadius: 14,
                    padding: '10px 14px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}
            >
                <span style={{ fontSize: 16 }} aria-hidden>
                    ⚡
                </span>
                <div className="flex flex-col">
                    <span className="font-semibold leading-tight" style={{ color: '#7dd3fc', fontSize: 12 }}>
                        Graphics quality reduced
                    </span>
                    <span className="leading-tight mt-0.5" style={{ color: 'rgba(255,255,255,0.75)', fontSize: 10 }}>
                        Particle density turned down for smoother performance on this device.
                    </span>
                </div>
            </div>
        </div>
    );
};
