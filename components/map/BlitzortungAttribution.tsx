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

    // Three strike styles — must stay visually identical to the actual
    // strike rendering in useLightningLayer.ts (white ⚡ glyph on a dark
    // polarity-tinted hit-spot). If you change the colors there, change
    // them here too.
    const POLARITY_LEGEND: { label: string; color: string }[] = [
        { label: '+CG', color: '#7c2d12' }, // deep amber-brown — positive cloud-to-ground
        { label: '−CG', color: '#0c4a6e' }, // deep navy — negative (most strikes)
        { label: 'Unknown', color: '#312e81' }, // deep indigo
    ];

    return (
        <div
            // Positioning lessons learned the hard way (2026-04-25):
            //  - `absolute left-2 bottom-2` was invisible — something at
            //    the bottom of the chart was sitting on top.
            //  - `fixed` positioning was proven to render in a diagnostic
            //    pass. We keep it — robust against any parent overflow
            //    or stacking-context surprises.
            //  - bottom-96px clears the menu bar.
            //  - max(96px, env(safe-area-inset-bottom)+80px) for iPhone
            //    safe-area on notched phones.
            className="fixed left-2 z-[140] pointer-events-auto chart-chip-up"
            style={{ bottom: 'max(96px, calc(env(safe-area-inset-bottom) + 80px))' }}
            role="contentinfo"
            aria-label="Lightning data attribution and connection status"
        >
            <div
                // Match ThalassaHelixControl's scrubber-pill look so the
                // lightning chip reads as part of the same control family
                // — slate translucent fill, heavy blur, subtle white
                // border, 16px radius.
                //
                // Two-column layout: vertical polarity legend on the left
                // (so the user knows which colour means what), status +
                // attribution stack on the right. Mirrors the other map
                // legends' "swatch + label" style, applied to lightning.
                className={`flex items-center gap-3 text-[11px] leading-tight ${styles.text}`}
                style={{
                    background: 'rgba(15, 23, 42, 0.80)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 16,
                    padding: '6px 12px',
                }}
            >
                {/* Vertical polarity legend — three rows, each showing a
                    miniature of the actual strike rendering (white ⚡ on
                    a dark polarity-tinted disc) plus its label. */}
                <div className="flex flex-col gap-1">
                    {POLARITY_LEGEND.map(({ label: l, color }) => (
                        <div key={l} className="flex items-center gap-1.5">
                            <span
                                className="inline-flex items-center justify-center h-4 w-4 rounded-full text-[10px] leading-none"
                                style={{
                                    background: color,
                                    border: '0.5px solid rgba(255,255,255,0.45)',
                                    color: '#ffffff',
                                }}
                                aria-hidden
                            >
                                ⚡
                            </span>
                            <span className="text-[10px] font-semibold tracking-wide text-white/75">{l}</span>
                        </div>
                    ))}
                </div>

                {/* Vertical divider */}
                <div className="self-stretch w-px bg-white/10" aria-hidden />

                {/* Status + attribution stack */}
                <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${styles.dot}`} aria-hidden />
                        <span className="font-semibold">{label}</span>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] opacity-80">
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
            </div>
        </div>
    );
};
