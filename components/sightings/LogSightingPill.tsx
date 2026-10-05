/**
 * The under-way way in: a big emerald 'Sighting' pill on the Log page's live
 * map (and its fullscreen map). One tap opens the quick log sheet; the moment
 * of the tap is the sighting's time, even if the sheet's code takes a beat
 * to load.
 *
 * Not in the footer (at 320 px it already squeezes 'New Log Entry') and not
 * on the Obs chart (a crowded control stack beside the red MOB button invites
 * a mis-tap). The sheet itself is a lazy chunk, fetched when the pill first
 * shows so the first tap at sea is instant.
 */
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { lazyRetry } from '../../utils/lazyRetry';
import { BinocularsGlyph } from './BinocularsGlyph';

const loadSheet = () => import('./QuickLogSheet');
const QuickLogSheet = lazyRetry(() => loadSheet().then((m) => ({ default: m.QuickLogSheet })), 'QuickLogSheet');

export const LogSightingPill: React.FC<{
    /** The live map must unmount while the sheet is up: iOS paints Leaflet above fixed overlays. */
    onOpenChange?: (open: boolean) => void;
    className?: string;
    style?: React.CSSProperties;
}> = ({ onOpenChange, className = '', style }) => {
    const [openedAt, setOpenedAt] = useState<number | null>(null);

    useEffect(() => {
        // Warm the chunk while the skipper is looking at the map, not at the tap.
        const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
        const warm = () => void loadSheet().catch(() => undefined);
        if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(warm);
        else setTimeout(warm, 1500);
    }, []);

    const open = useCallback(() => {
        setOpenedAt(Date.now());
        onOpenChange?.(true);
    }, [onOpenChange]);
    const close = useCallback(() => {
        setOpenedAt(null);
        onOpenChange?.(false);
    }, [onOpenChange]);

    return (
        <>
            <button
                type="button"
                onClick={open}
                aria-haspopup="dialog"
                aria-label="Log a sighting"
                data-testid="log-sighting-pill"
                className={`flex h-[48px] min-w-[48px] items-center gap-2 rounded-full bg-emerald-700 pl-3.5 pr-4 text-[13px] font-black uppercase tracking-[0.08em] text-white shadow-lg shadow-emerald-900/40 transition-transform active:scale-95 ${className}`}
                style={style}
            >
                <BinocularsGlyph className="h-5 w-5" />
                Sighting
            </button>
            {openedAt !== null && (
                <Suspense fallback={null}>
                    <QuickLogSheet openedAt={openedAt} onClose={close} />
                </Suspense>
            )}
        </>
    );
};
