/**
 * BlitzortungAttribution — required attribution + live diagnostic pill
 * for the Blitzortung.org lightning data feed.
 *
 * Blitzortung's terms of service require visible attribution whenever
 * their data is rendered. They run a community-funded volunteer detector
 * network and ask only for credit + (for commercial use) emailed
 * permission.
 *
 * The chip also doubles as a connection-status indicator so the user can
 * tell at a glance whether the WebSocket is healthy. Without this, a
 * silent connection failure looked identical to "no active lightning
 * anywhere in the world right now" and the user had no way to tell.
 *
 * States shown (colour-coded border):
 *   connecting  → amber   · "Connecting to …"
 *   open        → green   · "Live · N strikes"
 *   stalled     → orange  · "Stalled — reconnecting"
 *   closed      → red     · "Disconnected"
 *   unsupported → slate   · "Web — server relay required"
 */
import React, { useEffect, useState } from 'react';
import { subscribeLightningStatus, type StatusSnapshot } from '../../services/weather/api/blitzortungLightning';

interface BlitzortungAttributionProps {
    visible: boolean;
}

const STATUS_STYLES: Record<
    StatusSnapshot['status'],
    { border: string; pill: string; dot: string; label: (s: StatusSnapshot) => string }
> = {
    connecting: {
        border: 'border-amber-400/50',
        pill: 'bg-amber-400/20 text-amber-200',
        dot: 'bg-amber-400 animate-pulse',
        label: (s) => `Connecting${s.retryAttempts > 0 ? ` (retry ${s.retryAttempts})` : '…'}`,
    },
    open: {
        border: 'border-emerald-400/50',
        pill: 'bg-emerald-500/20 text-emerald-200',
        dot: 'bg-emerald-400',
        label: (s) =>
            s.strikesReceived > 0
                ? `Live · ${s.strikesReceived.toLocaleString()} strikes`
                : 'Live · waiting for strikes',
    },
    stalled: {
        border: 'border-orange-400/50',
        pill: 'bg-orange-500/20 text-orange-200',
        dot: 'bg-orange-400 animate-pulse',
        label: () => 'Stalled — reconnecting',
    },
    closed: {
        border: 'border-red-400/50',
        pill: 'bg-red-500/20 text-red-200',
        dot: 'bg-red-400',
        label: (s) => (s.retryAttempts > 0 ? `Reconnecting (${s.retryAttempts})` : 'Disconnected'),
    },
    unsupported: {
        border: 'border-slate-400/40',
        pill: 'bg-slate-500/20 text-slate-200',
        dot: 'bg-slate-400',
        label: () => 'Web — relay required',
    },
};

export const BlitzortungAttribution: React.FC<BlitzortungAttributionProps> = ({ visible }) => {
    const [status, setStatus] = useState<StatusSnapshot | null>(null);

    useEffect(() => {
        if (!visible) return;
        const unsub = subscribeLightningStatus(setStatus);
        return unsub;
    }, [visible]);

    if (!visible) return null;

    const styles = status ? STATUS_STYLES[status.status] : STATUS_STYLES.connecting;
    const label = status ? styles.label(status) : 'Connecting…';

    return (
        <div
            // z-[9999] beats every other map overlay — the chip is the
            // lightning feed's only user-facing health indicator and it
            // MUST be visible. Lifted off bottom-2 to bottom-20 so it
            // doesn't collide with the radial menu's bottom-edge fan.
            className="absolute left-3 bottom-20 z-[9999] pointer-events-auto max-w-[320px]"
            role="contentinfo"
            aria-label="Lightning data attribution and connection status"
        >
            <div
                className={`rounded-lg border ${styles.border} bg-black/70 backdrop-blur-sm px-2 py-1.5 text-[10px] leading-tight text-amber-100/80 flex flex-col gap-1`}
            >
                <div className="flex items-center gap-1.5">
                    <span className={`inline-block h-2 w-2 rounded-full ${styles.dot}`} aria-hidden />
                    <span className={`font-semibold px-1.5 py-0.5 rounded ${styles.pill}`}>{label}</span>
                </div>
                <div className="text-[9px] opacity-80">
                    <span className="font-bold text-amber-300">⚡</span>{' '}
                    <a
                        href="https://www.blitzortung.org"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-amber-200"
                    >
                        Blitzortung.org
                    </a>{' '}
                    · community detector network
                </div>
            </div>
        </div>
    );
};
