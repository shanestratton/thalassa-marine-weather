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
        text: 'text-white/85',
        label: (s) => `Connecting${s.retryAttempts > 0 ? ` (retry ${s.retryAttempts})` : '…'}`,
    },
    open: {
        dot: 'bg-emerald-400',
        text: 'text-white/85',
        label: (s) => {
            // Strictly viewport-scoped numbers — user only cares about
            // the storm on their screen, not what's happening in
            // Indonesia. When there's nothing in view, we just say so;
            // global counts were noise.
            if (s.viewportCount > 0) {
                return `Live · ${s.viewportCount} on screen (${s.viewportRate}/min)`;
            }
            return 'Live · no strikes in view';
        },
    },
    stalled: {
        dot: 'bg-orange-400 animate-pulse',
        text: 'text-white/85',
        label: () => 'Stalled — reconnecting',
    },
    closed: {
        dot: 'bg-red-400',
        text: 'text-white/85',
        label: (s) => (s.retryAttempts > 0 ? `Reconnecting (${s.retryAttempts})` : 'Disconnected'),
    },
    unsupported: {
        dot: 'bg-slate-400',
        text: 'text-white/85',
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
            // Positioning lessons learned the hard way (2026-04-25):
            //
            //  - `absolute left-2 bottom-2` (matching CmemsAttribution
            //    literally) was invisible — something at the bottom of
            //    the chart (radial menu, bottom nav?) was sitting on top.
            //  - `fixed` positioning was proven to render in a diagnostic
            //    pass. So we keep `fixed` here — it's robust against any
            //    parent overflow:hidden or stacking-context surprises.
            //  - bottom-24 (96px) clears the bottom menu/nav area. Earlier
            //    feedback at bottom-20 (80px) was "half over the menu",
            //    so 96px gives a small safety margin.
            //  - Add iOS safe-area inset so the home-indicator zone on
            //    notched iPhones doesn't push the chip onto the indicator
            //    in landscape orientations.
            className="fixed left-2 z-[140] pointer-events-auto max-w-[320px]"
            style={{ bottom: 'max(96px, calc(env(safe-area-inset-bottom) + 80px))' }}
            role="contentinfo"
            aria-label="Lightning data attribution and connection status"
        >
            <div
                // Match ThalassaHelixControl's scrubber-pill look so the
                // lightning chip reads as part of the same control family
                // — slate translucent fill, heavy blur, subtle white
                // border, 16px radius. Same dimensions feel as the
                // wind/rain "play next hour" button.
                className={`flex items-center gap-2 text-[11px] leading-tight ${styles.text}`}
                style={{
                    background: 'rgba(15, 23, 42, 0.80)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 16,
                    padding: '6px 12px',
                }}
            >
                <span className={`inline-block h-2 w-2 rounded-full ${styles.dot}`} aria-hidden />
                <span className="font-semibold">{label}</span>
                <span className="opacity-40">·</span>
                <span className="font-bold text-amber-300">⚡</span>
                <a
                    href="https://www.blitzortung.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white/85 underline-offset-2 hover:underline"
                >
                    Blitzortung.org
                </a>
            </div>
        </div>
    );
};
