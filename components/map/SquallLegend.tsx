/**
 * SquallLegend — vertical colormap legend + freshness pill for the
 * squall threat layer.
 *
 * Mirrors BlitzortungAttribution's structure: scrubber-pill shell
 * (slate translucent, blur, 16px radius), two-column layout — colormap
 * key on the left, status + label on the right. Lives in the same
 * bottom-left corner as the lightning chip; the two layers are mutually
 * exclusive in the radial menu so they share the anchor without
 * colliding.
 *
 * Source-of-truth for the swatch colours is `SQUALL_COLOR_RAMP` in
 * isobarLayerSetup.ts. If you change one, change the other so what the
 * user sees on the chart matches what they see in the legend.
 */
import React, { useEffect, useState } from 'react';

interface SquallLegendProps {
    visible: boolean;
}

const TIERS: { label: string; color: string }[] = [
    { label: 'Possible', color: 'rgba(255,235,59,0.9)' }, // soft yellow
    { label: 'Strong', color: 'rgba(255,150,0,1)' }, // orange
    { label: 'Severe', color: 'rgba(229,28,35,1)' }, // red
    { label: 'Extreme', color: 'rgba(170,0,180,1)' }, // magenta
];

export const SquallLegend: React.FC<SquallLegendProps> = ({ visible }) => {
    // Tick the live age indicator from the global module-level ref the
    // squall hook stamps on every refresh. Updated once a minute — same
    // cadence the squall hook itself uses.
    const [ageMin, setAgeMin] = useState<number | null>(null);
    useEffect(() => {
        if (!visible) return;
        const tick = () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const last = (window as any).__thalassaSquallLastRefreshAt as number | undefined;
            if (!last) {
                setAgeMin(null);
                return;
            }
            setAgeMin(Math.max(0, Math.round((Date.now() - last) / 60_000)));
        };
        tick();
        const t = setInterval(tick, 60_000);
        return () => clearInterval(t);
    }, [visible]);

    if (!visible) return null;

    // Status dot + label match the lightning chip's vocabulary so the
    // two legends feel like part of the same family.
    let dotClass = 'bg-emerald-400';
    // Match the "Live" capitalisation used elsewhere on the chart
    // (BlitzortungAttribution, scrubber sublabels). All-caps "LIVE"
    // was visually shouty in a chip alongside lower-case body text.
    let statusLabel = 'Live';
    if (ageMin === null) {
        dotClass = 'bg-amber-400 animate-pulse';
        statusLabel = 'Loading…';
    } else if (ageMin > 30) {
        dotClass = 'bg-red-400';
        statusLabel = ageMin >= 60 ? `${Math.floor(ageMin / 60)}h ${ageMin % 60}m` : `${ageMin}m`;
    } else if (ageMin > 5) {
        dotClass = 'bg-amber-400';
        statusLabel = `${ageMin}m`;
    }

    return (
        <div
            // Same anchor as BlitzortungAttribution — fixed bottom-left,
            // lifted above the menu bar, iOS safe-area aware.
            className="fixed left-2 z-[140] pointer-events-auto chart-chip-up"
            style={{ bottom: 'max(96px, calc(env(safe-area-inset-bottom) + 80px))' }}
            role="contentinfo"
            aria-label="Squall intensity legend"
        >
            <div
                className="flex items-center gap-3 text-[11px] leading-tight text-white/85"
                style={{
                    background: 'rgba(15, 23, 42, 0.80)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 16,
                    padding: '6px 12px',
                }}
            >
                {/* Vertical colormap legend — four tiers, swatch + label */}
                <div className="flex flex-col gap-1">
                    {TIERS.map(({ label, color }) => (
                        <div key={label} className="flex items-center gap-1.5">
                            <span
                                className="inline-block h-3 w-3 rounded-sm shrink-0"
                                style={{ background: color, border: '0.5px solid rgba(255,255,255,0.2)' }}
                                aria-hidden
                            />
                            <span className="text-[10px] font-semibold tracking-wide text-white/75">{label}</span>
                        </div>
                    ))}
                </div>

                {/* Vertical divider */}
                <div className="self-stretch w-px bg-white/10" aria-hidden />

                {/* Status + label */}
                <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
                        <span className="font-semibold">{statusLabel}</span>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] opacity-80">
                        <span>⛈️</span>
                        <span className="font-bold text-white/85">Squall</span>
                    </div>
                </div>
            </div>
        </div>
    );
};
