/**
 * SquallLegend — vertical colormap legend + freshness pill for the
 * squall threat layer.
 *
 * Mirrors BlitzortungAttribution's structure: scrubber-pill shell
 * (slate translucent, blur, 16px radius), two-column layout — colormap
 * key on the left, status + label on the right. Lives in the chart's
 * large blue information panel, keeping the map and scrubber unobstructed.
 *
 * Source-of-truth for the swatch colours is `SQUALL_COLOR_RAMP` in
 * isobarLayerSetup.ts. If you change one, change the other so what the
 * user sees on the chart matches what they see in the legend.
 */
import React, { useEffect, useState } from 'react';
import { squallStatusText, useSquallStatus } from '../../services/weather/squallStatus';

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
    const status = useSquallStatus();
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!visible) return;
        const tick = () => setNow(Date.now());
        tick();
        const t = setInterval(tick, 60_000);
        window.addEventListener('focus', tick);
        document.addEventListener('visibilitychange', tick);
        return () => {
            clearInterval(t);
            window.removeEventListener('focus', tick);
            document.removeEventListener('visibilitychange', tick);
        };
    }, [visible]);

    if (!visible) return null;

    const ageMin = status.snapshotTimeMs === null ? null : Math.floor((now - status.snapshotTimeMs) / 60_000);
    let dotClass = 'bg-emerald-400';
    const statusLabel = squallStatusText(status, now);
    if (status.error || (ageMin !== null && ageMin > 30)) {
        dotClass = 'bg-red-400';
    } else if (status.phase === 'loading' || !status.tilesReady) {
        dotClass = 'bg-amber-400 animate-pulse';
    } else if (ageMin === null || ageMin < 0 || ageMin > 10) {
        dotClass = 'bg-amber-400';
    }

    // Inline in System Status: no chart entrance animation or map positioning.
    return (
        <div
            className="flex items-center gap-3 text-[11px] leading-tight text-white/85 pointer-events-auto"
            style={{
                background: 'var(--day-ui-surface, rgba(15, 23, 42, 0.80))',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid var(--day-ui-border, rgba(255,255,255,0.08))',
                borderRadius: 16,
                padding: '6px 12px',
            }}
            role="contentinfo"
            aria-label="Squall intensity legend"
        >
            {/* Vertical colormap legend — four tiers, swatch + label */}
            <div className="flex flex-col gap-1">
                {TIERS.map(({ label, color }) => (
                    <div key={label} className="flex items-center gap-1.5">
                        <span
                            className="inline-block h-3 w-3 rounded-xs shrink-0"
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
                    <span className="font-semibold" role={status.error ? 'alert' : undefined}>
                        {statusLabel}
                    </span>
                </div>
                <div className="flex items-center gap-1 text-[10px] opacity-80">
                    <span>⛈️</span>
                    <span className="font-bold text-white/85">Squall</span>
                </div>
                <span className="text-[10px] opacity-80">Heavy-rain proxy · Rainbow.ai</span>
            </div>
        </div>
    );
};
