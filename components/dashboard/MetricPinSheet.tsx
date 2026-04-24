/**
 * MetricPinSheet — Modal sheet for pinning a metric to the hero's top slot.
 *
 * Opens from the hero card's temp area. Lists the 10 pinnable metrics
 * (the same IDs shown in the HeroWidgets 5×2 grid) plus a "Temperature"
 * reset option. Selecting a metric writes it to settings.heroMetric; the
 * Glass page then renders that metric in the hero slot and moves
 * temperature into the grid cell the metric vacated.
 *
 * Phase 1 implementation — tap-to-pick. Phase 2 will upgrade the trigger
 * to drag-and-drop from the grid (long-press activation, framer-motion
 * swap animation) while keeping the same state model and persistence.
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { WindIcon, WaveIcon, GaugeIcon, DropletIcon, SunIcon, EyeIcon, CompassIcon, ThermometerIcon } from '../Icons';
import { AnimatedRainIcon } from '../ui/AnimatedIcons';

// Canonical list of pinnable metrics. Order matches the 5×2 grid in
// HeroWidgets.tsx (top row then bottom row). Each entry carries the
// id used in settings.heroMetric + a short label + the icon that appears
// next to it in the grid, so the picker visually matches what the user
// sees on the Glass page.
export interface PinnableMetric {
    id: string;
    label: string;
    helper: string; // short description shown below the label
    icon: React.ReactNode;
}

export const PINNABLE_METRICS: PinnableMetric[] = [
    { id: 'wind', label: 'WIND', helper: 'Sustained wind speed', icon: <WindIcon className="w-4 h-4" /> },
    { id: 'dir', label: 'DIR', helper: 'Wind direction', icon: <CompassIcon className="w-4 h-4" rotation={0} /> },
    { id: 'gust', label: 'GUST', helper: 'Peak gust speed', icon: <WindIcon className="w-4 h-4" /> },
    { id: 'wave', label: 'WAVE', helper: 'Wave / swell height', icon: <WaveIcon className="w-4 h-4" /> },
    { id: 'period', label: 'PER.', helper: 'Wave / swell period', icon: <WaveIcon className="w-4 h-4" /> },
    { id: 'uv', label: 'UV', helper: 'UV Index', icon: <SunIcon className="w-4 h-4" /> },
    { id: 'vis', label: 'VIS', helper: 'Visibility', icon: <EyeIcon className="w-4 h-4" /> },
    { id: 'pressure', label: 'HPA', helper: 'Barometric pressure', icon: <GaugeIcon className="w-4 h-4" /> },
    { id: 'humidity', label: 'HUM', helper: 'Relative humidity', icon: <DropletIcon className="w-4 h-4" /> },
    { id: 'rain', label: 'RAIN', helper: 'Precipitation', icon: <AnimatedRainIcon className="w-4 h-4" /> },
];

interface MetricPinSheetProps {
    visible: boolean;
    currentMetric: string; // the currently pinned metric id (or 'temp')
    onPick: (id: string) => void; // called with 'temp' for reset or any PINNABLE id
    onClose: () => void;
    /**
     * Location type for per-location eligibility filtering. Marine-only
     * metrics (wave / period) get hidden for inland / landlocked users
     * so the picker stays short and relevant. Coastal / inshore / offshore
     * see the full list.
     */
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
}

/**
 * Filter the canonical pinnable-metrics list down to what's actually
 * relevant for the user's current location type. Keeps the picker honest —
 * a user sitting on a landlocked lake doesn't want "swell height" cluttering
 * the pin sheet.
 */
function filterForLocation(all: PinnableMetric[], locationType: MetricPinSheetProps['locationType']): PinnableMetric[] {
    if (locationType === 'inland') {
        return all.filter((m) => m.id !== 'wave' && m.id !== 'period');
    }
    return all;
}

export const MetricPinSheet: React.FC<MetricPinSheetProps> = ({
    visible,
    currentMetric,
    onPick,
    onClose,
    locationType,
}) => {
    const visibleMetrics = filterForLocation(PINNABLE_METRICS, locationType);
    // ESC closes the sheet
    useEffect(() => {
        if (!visible) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [visible, onClose]);

    // Lock body scroll while open
    useEffect(() => {
        if (!visible) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prev;
        };
    }, [visible]);

    if (!visible) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[9998] flex items-end sm:items-center justify-center"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Pin a metric to the hero slot"
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200" />

            {/* Sheet */}
            <div
                className="relative w-full max-w-md bg-slate-900/95 border-t sm:border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[85dvh] overflow-hidden animate-in slide-in-from-bottom sm:zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
                {/* Header */}
                <div className="px-5 pt-5 pb-3 border-b border-white/[0.06] sticky top-0 bg-slate-900/95 z-10">
                    <h2 className="text-base font-bold text-white tracking-tight">Pin a metric to the top</h2>
                    <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                        The selected metric replaces temperature in the hero. Temperature moves to its grid cell.
                    </p>
                </div>

                {/* Scrollable list */}
                <div className="overflow-y-auto max-h-[60dvh] px-3 py-3 space-y-1.5">
                    {/* Temperature — reset to default */}
                    <button
                        onClick={() => onPick('temp')}
                        aria-label="Reset to temperature"
                        aria-current={currentMetric === 'temp' ? 'true' : undefined}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
                            currentMetric === 'temp'
                                ? 'bg-sky-500/15 border-sky-400/40'
                                : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
                        }`}
                    >
                        <div
                            className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                                currentMetric === 'temp'
                                    ? 'bg-sky-500/20 text-sky-300'
                                    : 'bg-white/[0.04] text-slate-400'
                            }`}
                        >
                            <ThermometerIcon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0 text-left">
                            <p
                                className={`text-xs font-bold uppercase tracking-widest ${
                                    currentMetric === 'temp' ? 'text-sky-200' : 'text-white'
                                }`}
                            >
                                Temperature
                            </p>
                            <p className="text-[11px] text-slate-400 truncate">Default — air temperature</p>
                        </div>
                        {currentMetric === 'temp' && (
                            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-sky-300">
                                Active
                            </span>
                        )}
                    </button>

                    {/* Divider */}
                    <div className="h-px bg-white/[0.06] my-2" />

                    {/* The 10 pinnable metrics */}
                    {visibleMetrics.map((m) => {
                        const isActive = currentMetric === m.id;
                        return (
                            <button
                                key={m.id}
                                onClick={() => onPick(m.id)}
                                aria-label={`Pin ${m.helper} to the hero slot`}
                                aria-current={isActive ? 'true' : undefined}
                                className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
                                    isActive
                                        ? 'bg-sky-500/15 border-sky-400/40'
                                        : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
                                }`}
                            >
                                <div
                                    className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                                        isActive ? 'bg-sky-500/20 text-sky-300' : 'bg-white/[0.04] text-slate-400'
                                    }`}
                                >
                                    {m.icon}
                                </div>
                                <div className="flex-1 min-w-0 text-left">
                                    <p
                                        className={`text-xs font-bold uppercase tracking-widest ${
                                            isActive ? 'text-sky-200' : 'text-white'
                                        }`}
                                    >
                                        {m.label}
                                    </p>
                                    <p className="text-[11px] text-slate-400 truncate">{m.helper}</p>
                                </div>
                                {isActive && (
                                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-sky-300">
                                        Active
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-white/[0.06]">
                    <button
                        onClick={onClose}
                        aria-label="Close pin a metric sheet"
                        className="w-full py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-slate-300 text-sm font-bold uppercase tracking-wider hover:bg-white/[0.08] transition-colors"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

MetricPinSheet.displayName = 'MetricPinSheet';
