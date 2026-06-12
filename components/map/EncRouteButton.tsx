/**
 * "Plan ENC Route" — one-tap demo button that runs `tryInshoreRoute` against
 * the user's imported ENC cells and renders the result on the chart.
 *
 * Hardcoded Newport → Rivergate Brisbane River trip for the initial demo —
 * once that's known-good, swap in a real two-tap workflow (long-press From,
 * long-press To, button confirms).
 */
import React, { useState } from 'react';

import { tryInshoreRoute } from '../../services/InshoreRouter';
import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';
import type { EncTestRoute } from './useEncTestRouteLayer';

const log = createLogger('EncRouteButton');

// Demo waypoints — Tayana 55 draft for the safety margin.
const DEMO_FROM = { lat: -27.157, lon: 153.103 }; // Newport Marina, QLD
const DEMO_TO = { lat: -27.435, lon: 153.105 }; // Rivergate Marina, Brisbane River
const DEMO_DRAFT_M = 1.9;

interface Props {
    encCellCount: number;
    onRoute: (route: EncTestRoute | null) => void;
}

export const EncRouteButton: React.FC<Props> = ({ encCellCount, onRoute }) => {
    const [busy, setBusy] = useState(false);
    const [lastResult, setLastResult] = useState<string | null>(null);

    if (encCellCount === 0) return null;

    const run = async () => {
        triggerHaptic('light');
        setBusy(true);
        setLastResult(null);
        log.warn(`button tap — Newport→Rivergate, draft ${DEMO_DRAFT_M} m`);
        try {
            const res = await tryInshoreRoute(DEMO_FROM, DEMO_TO, DEMO_DRAFT_M);
            if (res && 'polyline' in res) {
                onRoute({ polyline: res.polyline, cautionMask: res.cautionMask });
                const cautionCount = res.cautionMask?.filter(Boolean).length ?? 0;
                setLastResult(`${res.distanceNM.toFixed(1)} NM · ${res.polyline.length} pts · ${cautionCount} caution`);
            } else if (res && 'error' in res) {
                onRoute(null);
                log.warn(`route failed: ${res.error}`);
                setLastResult('No safe route through charted water');
            } else {
                onRoute(null);
                log.warn('no route — request gated outside charted cells');
                setLastResult('Route outside charted cells');
            }
        } catch (err) {
            onRoute(null);
            log.error('route crashed:', err);
            setLastResult('Routing failed — try again');
        } finally {
            setBusy(false);
        }
    };

    return (
        // Horizontally-centred under the top FABs / Status pill. top-[140px]
        // clears the right-rail LayerFAB (top-[80px], 48px tall) and the
        // status pill (top-[56px]); pinning to centre also keeps it clear of
        // both the left-edge status pill and the right-rail FAB column.
        <div className="absolute z-[600] top-[140px] left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5">
            <button
                aria-label="Plan ENC test route"
                onClick={run}
                disabled={busy}
                className={`min-h-[44px] px-3 py-2 rounded-full backdrop-blur-md border text-[11px] font-bold uppercase tracking-wider shadow-lg transition-all ${
                    busy
                        ? 'bg-violet-500/30 text-violet-200 border-violet-400/40'
                        : 'bg-black/60 text-violet-300 border-violet-400/30 hover:bg-violet-500/20 active:scale-95'
                }`}
            >
                {busy ? '⏳ Routing…' : '🗺 Plan ENC Route'}
            </button>
            {lastResult && (
                <div className="px-2.5 py-1 rounded-full bg-black/60 border border-violet-400/20 text-[10px] text-violet-200 max-w-[200px] truncate">
                    {lastResult}
                </div>
            )}
        </div>
    );
};
