import { useEffect, useId, useRef, useState } from 'react';
import { triggerHaptic } from '../../utils/system';
import { PUBLIC_BETA_ACCESS } from '../../services/SubscriptionService';

export type MapBaseKind = 'hybrid' | 'satellite' | 'ocean';

export function mapBaseVisibility(value: MapBaseKind): {
    hybrid: boolean;
    satellite: boolean;
    ocean: boolean;
} {
    return {
        hybrid: value === 'hybrid',
        satellite: value === 'satellite',
        ocean: value === 'ocean',
    };
}

const MAP_BASE_OPTIONS: ReadonlyArray<{
    id: MapBaseKind;
    label: string;
    description: string;
}> = [
    { id: 'hybrid', label: 'Hybrid', description: 'Imagery with place names' },
    { id: 'satellite', label: 'Satellite', description: 'Clean aerial imagery' },
    { id: 'ocean', label: 'Ocean', description: 'Bathymetry background' },
];

export interface MapBaseSelectorProps {
    visible: boolean;
    value: MapBaseKind;
    onChange: (value: MapBaseKind) => void;
}

/**
 * Compact visual-base picker for the browsing chart. It deliberately changes
 * only the raster underneath the ENC stack; navigation marks, safety depth and
 * route checks remain owned by their existing layers.
 */
export function MapBaseSelector({ visible, value, onChange }: MapBaseSelectorProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const menuId = useId();
    const selected = MAP_BASE_OPTIONS.find((option) => option.id === value) ?? MAP_BASE_OPTIONS[0];

    useEffect(() => {
        if (!visible) setOpen(false);
    }, [visible]);

    useEffect(() => {
        if (!open) return;
        optionRefs.current[MAP_BASE_OPTIONS.findIndex((option) => option.id === value)]?.focus({ preventScroll: true });

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutsidePointer);
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
    }, [open, value]);

    if (!visible) return null;

    return (
        <div
            ref={rootRef}
            className="absolute left-4 z-[710]"
            style={{ top: 'calc(env(safe-area-inset-top) + 68px)' }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpen(false);
                    triggerRef.current?.focus({ preventScroll: true });
                    return;
                }
                if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
                event.preventDefault();
                const focusedIndex = optionRefs.current.findIndex((option) => option === document.activeElement);
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                const nextIndex = (focusedIndex + direction + MAP_BASE_OPTIONS.length) % MAP_BASE_OPTIONS.length;
                optionRefs.current[nextIndex]?.focus({ preventScroll: true });
            }}
        >
            <button
                ref={triggerRef}
                type="button"
                onClick={() => {
                    triggerHaptic('light');
                    setOpen((current) => !current);
                }}
                className="flex min-h-[44px] items-center gap-2 rounded-2xl border border-white/[0.10] bg-slate-900/90 px-3 text-white shadow-xl backdrop-blur-xl transition-colors hover:bg-slate-800/95 active:scale-95"
                aria-label={`Map base: ${selected.label}`}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
            >
                <MapBaseIcon />
                <span className="text-[10px] font-black uppercase tracking-wider">{selected.label}</span>
                {PUBLIC_BETA_ACCESS.enabled && (
                    <span className="rounded border border-cyan-300/25 bg-cyan-300/10 px-1 py-0.5 text-[8px] font-black uppercase tracking-wider text-cyan-200">
                        Free Beta
                    </span>
                )}
                <span className="text-[10px] text-slate-400" aria-hidden="true">
                    {open ? '▴' : '▾'}
                </span>
            </button>

            {open && (
                <div
                    id={menuId}
                    role="menu"
                    aria-label="Map base"
                    className="mt-2 w-[min(280px,calc(100vw-32px))] rounded-2xl border border-white/[0.10] bg-slate-950/95 p-2 shadow-2xl backdrop-blur-xl"
                >
                    <p className="px-2 pb-2 pt-1 text-[10px] font-semibold leading-snug text-slate-400">
                        Visual background only — ENC safety layers stay above it.
                    </p>
                    {MAP_BASE_OPTIONS.map((option, index) => {
                        const checked = option.id === value;
                        return (
                            <button
                                key={option.id}
                                ref={(element) => {
                                    optionRefs.current[index] = element;
                                }}
                                type="button"
                                role="menuitemradio"
                                aria-checked={checked}
                                onClick={() => {
                                    triggerHaptic('light');
                                    onChange(option.id);
                                    setOpen(false);
                                    triggerRef.current?.focus({ preventScroll: true });
                                }}
                                className={`flex min-h-[52px] w-full items-center justify-between rounded-xl px-3 text-left transition-colors active:scale-[0.98] ${
                                    checked
                                        ? 'border border-sky-400/35 bg-sky-500/15 text-sky-200'
                                        : 'border border-transparent text-slate-200 hover:bg-white/[0.06]'
                                }`}
                            >
                                <span>
                                    <span className="block text-xs font-black">{option.label}</span>
                                    <span className="block text-[10px] font-medium text-slate-400">
                                        {option.description}
                                    </span>
                                </span>
                                <span className={checked ? 'text-sky-300' : 'text-slate-600'} aria-hidden="true">
                                    {checked ? '●' : '○'}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function MapBaseIcon() {
    return (
        <svg className="h-4 w-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6.75l5.5-3 5.5 3 5.5-3v13.5l-5.5 3-5.5-3-5.5 3V6.75z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.25 3.75v13.5m5.5-10.5v13.5" />
        </svg>
    );
}
