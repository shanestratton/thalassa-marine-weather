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
import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePanePortalTarget } from '../../context/PanePortalContext';
import {
    WindIcon,
    WaveIcon,
    GaugeIcon,
    DropletIcon,
    SunIcon,
    EyeIcon,
    CompassIcon,
    ThermometerIcon,
    XIcon,
} from '../Icons';
import { GustIcon, PinIcon, WavePeriodIcon } from '../icons/GlassGlyphs';
import { AnimatedRainIcon } from '../ui/AnimatedIcons';
import { Button } from '../ui/Button';
import { useFocusTrap } from '../../hooks/useFocusTrap';

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
    { id: 'gust', label: 'GUST', helper: 'Peak gust speed', icon: <GustIcon className="w-4 h-4" /> },
    { id: 'wave', label: 'WAVE', helper: 'Wave / swell height', icon: <WaveIcon className="w-4 h-4" /> },
    { id: 'period', label: 'PERIOD', helper: 'Wave / swell period', icon: <WavePeriodIcon className="w-4 h-4" /> },
    { id: 'uv', label: 'UV', helper: 'UV Index', icon: <SunIcon className="w-4 h-4" /> },
    { id: 'vis', label: 'VIS', helper: 'Visibility', icon: <EyeIcon className="w-4 h-4" /> },
    { id: 'pressure', label: 'BARO', helper: 'Barometric pressure', icon: <GaugeIcon className="w-4 h-4" /> },
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

/** 'Sustained wind speed' → 'sustained wind speed' for mid-sentence use;
 *  acronyms such as 'UV Index' keep their capitals. */
function midSentence(helper: string): string {
    return /^[A-Z][a-z]/.test(helper) ? helper[0].toLowerCase() + helper.slice(1) : helper;
}

/** 'WIND' → 'Wind' for a spoken name that starts with the row's visible
 *  label; two-letter acronyms such as 'UV' keep their capitals. */
function spokenLabel(label: string): string {
    return label.length <= 2 ? label : label[0] + label.slice(1).toLowerCase();
}

export const MetricPinSheet: React.FC<MetricPinSheetProps> = ({
    visible,
    currentMetric,
    onPick,
    onClose,
    locationType,
}) => {
    const portalTarget = usePanePortalTarget();
    const titleId = useId();
    const visibleMetrics = filterForLocation(PINNABLE_METRICS, locationType);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(visible, { initialFocusRef: closeButtonRef, onEscape: onClose });

    // Lock body scroll while open
    useEffect(() => {
        if (!visible || portalTarget !== document.body) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prev;
        };
    }, [visible, portalTarget]);

    if (!visible) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-9998 flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={onClose}
            role="dialog"
            aria-modal={portalTarget?.tagName === 'BODY' ? true : undefined}
            aria-labelledby={titleId}
            ref={dialogRef}
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/70 backdrop-blur-xs animate-in fade-in duration-200" />

            {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
            <div
                className="relative w-full max-w-md bg-slate-900/95 border border-white/10 rounded-2xl shadow-2xl max-h-full overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header — the one Glass dialog header: icon, sentence-case
                    title, top-right close (UX scorecard run 6). */}
                <div className="px-5 pt-5 pb-3 border-b border-white/6 sticky top-0 bg-slate-900/95 z-10">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 shrink-0 rounded-full bg-sky-500/20 flex items-center justify-center">
                                <PinIcon className="w-4 h-4 text-sky-400" />
                            </div>
                            <h2 id={titleId} className="text-base font-bold text-white tracking-tight">
                                Pin a metric to the top
                            </h2>
                        </div>
                        <button
                            ref={closeButtonRef}
                            type="button"
                            onClick={onClose}
                            aria-label="Close pin a metric sheet"
                            className="hit-target-44 shrink-0 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                        >
                            <XIcon className="w-4 h-4" />
                        </button>
                    </div>
                    <p className="text-[12px] text-slate-400 mt-1 leading-relaxed">
                        The metric you pick becomes the big number at the top. Temperature moves to that metric&apos;s
                        grid cell.
                    </p>
                </div>

                {/* Scrollable list */}
                <div className="overflow-y-auto max-h-[60dvh] px-3 py-3 space-y-1.5">
                    {/* Temperature — reset to default. Every row is a pressed or
                        unpressed toggle, and the pressed one is named for what
                        it is, not for an action that would do nothing (UX
                        scorecard run 7: 'Reset to temperature' on the row
                        already showing it). */}
                    <button
                        onClick={() => onPick('temp')}
                        aria-label={
                            currentMetric === 'temp'
                                ? 'Temperature, pinned'
                                : 'Show air temperature as the big number at the top'
                        }
                        aria-pressed={currentMetric === 'temp'}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
                            currentMetric === 'temp'
                                ? 'bg-sky-500/15 border-sky-400/40'
                                : 'bg-white/3 border-white/6 hover:bg-white/6'
                        }`}
                    >
                        <div
                            aria-hidden="true"
                            className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                                currentMetric === 'temp' ? 'bg-sky-500/20 text-sky-300' : 'bg-white/4 text-slate-400'
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
                            <p className="text-[12px] text-slate-400 truncate">Default — air temperature</p>
                        </div>
                        {currentMetric === 'temp' && (
                            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-sky-300">
                                Active
                            </span>
                        )}
                    </button>

                    {/* Divider */}
                    <div className="h-px bg-white/6 my-2" />

                    {/* The 10 pinnable metrics */}
                    {visibleMetrics.map((m) => {
                        const isActive = currentMetric === m.id;
                        return (
                            <button
                                key={m.id}
                                onClick={() => onPick(m.id)}
                                aria-label={
                                    isActive
                                        ? `${spokenLabel(m.label)}, pinned — ${midSentence(m.helper)}`
                                        : `Show ${midSentence(m.helper)} as the big number at the top`
                                }
                                aria-pressed={isActive}
                                className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
                                    isActive
                                        ? 'bg-sky-500/15 border-sky-400/40'
                                        : 'bg-white/3 border-white/6 hover:bg-white/6'
                                }`}
                            >
                                {/* Decoration: the RAIN row's animated icon surfaced as
                                    an unnamed img inside the button (UX scorecard run 8). */}
                                <div
                                    aria-hidden="true"
                                    className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                                        isActive ? 'bg-sky-500/20 text-sky-300' : 'bg-white/4 text-slate-400'
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
                                    <p className="text-[12px] text-slate-400 truncate">{m.helper}</p>
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
                <div className="px-4 py-3 border-t border-white/6">
                    <Button onClick={onClose} className="w-full text-slate-300">
                        Close
                    </Button>
                </div>
            </div>
        </div>,
        portalTarget!,
    );
};

MetricPinSheet.displayName = 'MetricPinSheet';
