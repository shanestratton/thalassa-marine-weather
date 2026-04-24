/**
 * BlitzortungAttribution — single-line legend chip + diagnostic pill
 * for the Blitzortung.org lightning data feed.
 *
 * Blitzortung's terms of service require visible attribution whenever
 * their data is rendered. They run a volunteer detector network and
 * ask for credit; the credit doesn't have to be a clickable link or a
 * paragraph — just a visible mention of the source.
 *
 * Visual: matches `CmemsAttribution` — same compact single-line pill
 * style, same `left-2 bottom-2` corner. Adds a colour-coded status dot
 * (and animated where appropriate) so the chip doubles as the feed's
 * health indicator. Without that, "no strikes anywhere on screen" looks
 * identical to "WebSocket dropped 3 minutes ago".
 *
 * States shown via the dot + label:
 *   connecting  → amber pulse  · "Connecting…"
 *   open        → green static · "Live · 47 in view (12/min)"
 *                              · "Live · 1.2k global · 0 in view"
 *                              · "Live · waiting for strikes"
 *   stalled     → orange pulse · "Stalled — reconnecting"
 *   closed      → red static   · "Disconnected" / "Reconnecting (N)"
 *   unsupported → slate static · "Web — relay required"
 */
import React, { useEffect, useState } from 'react';
import { subscribeLightningStatus, type StatusSnapshot } from '../../services/weather/api/blitzortungLightning';

interface BlitzortungAttributionProps {
    visible: boolean;
}

const STATUS_STYLES: Record<
    StatusSnapshot['status'],
    { dot: string; text: string; label: (s: StatusSnapshot) => string }
> = {
    connecting: {
        dot: 'bg-amber-400 animate-pulse',
        text: 'text-amber-100/80',
        label: (s) => `Connecting${s.retryAttempts > 0 ? ` (retry ${s.retryAttempts})` : '…'}`,
    },
    open: {
        dot: 'bg-emerald-400',
        text: 'text-amber-100/80',
        label: (s) => {
            // Viewport-scoped numbers when there's something to look at,
            // global session count otherwise so the chip never goes blank.
            if (s.viewportCount > 0) {
                return `Live · ${s.viewportCount} in view (${s.viewportRate}/min)`;
            }
            if (s.strikesReceived > 0) {
                return `Live · ${s.strikesReceived.toLocaleString()} global`;
            }
            return 'Live · waiting for strikes';
        },
    },
    stalled: {
        dot: 'bg-orange-400 animate-pulse',
        text: 'text-orange-100/80',
        label: () => 'Stalled — reconnecting',
    },
    closed: {
        dot: 'bg-red-400',
        text: 'text-red-100/80',
        label: (s) => (s.retryAttempts > 0 ? `Reconnecting (${s.retryAttempts})` : 'Disconnected'),
    },
    unsupported: {
        dot: 'bg-slate-400',
        text: 'text-slate-200/80',
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
            // Same corner + z-index as CmemsAttribution. The lightning
            // chip and the CMEMS chip can never both be visible at the
            // same time (different layer toggles), so they share the
            // same anchor.
            className="absolute left-2 bottom-2 z-[140] pointer-events-auto max-w-[320px]"
            role="contentinfo"
            aria-label="Lightning data attribution and connection status"
        >
            <div
                className={`rounded-lg border border-amber-400/30 bg-black/60 backdrop-blur-sm px-2 py-1 text-[10px] leading-tight ${styles.text} flex items-center gap-1.5`}
            >
                <span className={`inline-block h-2 w-2 rounded-full ${styles.dot}`} aria-hidden />
                <span className="font-semibold">{label}</span>
                <span className="opacity-60">·</span>
                <span className="font-bold text-amber-300">⚡ Blitzortung</span>
            </div>
        </div>
    );
};
