/**
 * useEncChartInventory — "which ENC cells do we have, and is this water
 * covered?" Extracted verbatim from MapHub.
 *
 * First step of the MapHub decomposition, chosen as the pilot precisely
 * because it is the largest cohesive cluster that WRITES NO MAP LAYERS. It
 * owns three pieces of read-only inventory state and the subscriptions that
 * keep them current; nothing here paints, so an ordering mistake cannot
 * produce a silent visual regression — it would fail loudly or not at all.
 *
 * Everything below is moved unchanged, including the reasons each guard
 * exists. Those were bought with real audits and must not be re-derived:
 *
 *   - the z11 zoom gate, so browsing out to ocean scale does not claim "no
 *     coverage" when the chart simply is not meant to draw yet;
 *   - the 300 ms debounce on the cell-count refresh, because a 172-cell
 *     cloud registration fires one notify PER CELL and refreshing
 *     synchronously was an O(n²) parse burst on first signed-in boot;
 *   - count-only diagnostics, after joining all 172 ids built a ~2.5 KB
 *     string per notify and flooded the console during registration storms.
 *
 * DELIBERATELY LEFT IN MapHub: `setEncHydrationPaused(pickerMode)`. It sits
 * between the two ENC-popup effects, and one of those carries a literal
 * string that tests/ObsDepthPopupBoundary.test.ts asserts against the file as
 * raw text. Dragging it up here would move it across both.
 */

import { useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { listCells as listEncCells } from '../../services/enc/EncCellMetadata';
import {
    subscribe as subscribeToEnc,
    subscribeHydration as subscribeToEncHydration,
    getHydrationProgress as getEncHydrationProgress,
    hasCoverageFor as encHasCoverageFor,
} from '../../services/enc/EncHazardService';
import { bootstrapEncSamplesIfNeeded } from '../../services/enc/bootstrapEncSamples';
import { startAutoSyncPolling } from '../../services/enc/autoSyncFromPi';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MapHub');

export interface EncChartInventory {
    encCellCount: number;
    encHydration: ReturnType<typeof getEncHydrationProgress>;
    encNoCoverage: boolean;
}

export function useEncChartInventory(
    mapRef: React.RefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    encVisible: boolean,
): EncChartInventory {
    // Live cell-count so the layer FAB shows the right "N cells imported" caption
    // and surfaces the toggle the moment the first cell lands.
    const [encCellCount, setEncCellCount] = useState(() => listEncCells().length);
    // Cloud-chart hydration progress — silent downloads read as "no
    // chart here" (2026-07-12 audit): the punter needs to know dark
    // water is a cell still on its way down, not a gap in coverage.
    const [encHydration, setEncHydration] = useState(() => getEncHydrationProgress());
    useEffect(() => subscribeToEncHydration(setEncHydration), []);
    // No-coverage affordance (2026-07-17 audit): browsing genuinely
    // UNCHARTED water at nav zoom was indistinguishable from having the
    // chart layer off — the dark shell told the punter nothing. When the
    // viewport escapes every imported cell's bbox at z11+, say so.
    const [encNoCoverage, setEncNoCoverage] = useState(false);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !encVisible) {
            setEncNoCoverage(false);
            return;
        }
        const probe = (): void => {
            try {
                if (map.getZoom() < 11 || listEncCells().length === 0) {
                    setEncNoCoverage(false);
                    return;
                }
                const b = map.getBounds();
                if (!b) return;
                setEncNoCoverage(!encHasCoverageFor([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]));
            } catch {
                setEncNoCoverage(false);
            }
        };
        probe();
        map.on('moveend', probe);
        return () => {
            map.off('moveend', probe);
        };
        // mapRef is a stable ref object, so naming it satisfies the linter
        // without changing when this runs — MapHub's original deps were
        // [mapReady, encVisible] and the behaviour is identical.
    }, [mapRef, mapReady, encVisible]);
    useEffect(() => {
        const refresh = () => {
            const cells = listEncCells();
            // Diagnostic — count only: joining all 172 cloud-cell ids
            // built a ~2.5 KB string per notify and flooded the console
            // during registration storms (2026-07-12 audit).
            log.info(`encCellCount = ${cells.length}`);
            setEncCellCount(cells.length);
        };
        refresh();
        // Debounced: a 172-cell cloud registration fires one notify PER
        // CELL; refreshing synchronously each time was an O(n²) parse
        // burst on first signed-in boot.
        let t: number | null = null;
        const unsub = subscribeToEnc(() => {
            if (t !== null) window.clearTimeout(t);
            t = window.setTimeout(() => {
                t = null;
                refresh();
            }, 300);
        });
        return () => {
            if (t !== null) window.clearTimeout(t);
            unsub();
        };
    }, []);
    // One-shot import of any bundled sample cells the dev server is serving.
    // No-op once the localStorage flag is set or when real cells already exist.
    useEffect(() => {
        void bootstrapEncSamplesIfNeeded();
        // After the bundled NOAA demo lands, also check if the user's Bosun
        // Pi is reachable on local wifi and silently pull any AU/NZ/EU cells
        // they've decrypted there. Polling — runs immediately + every 10 min
        // while foregrounded so a user who buys a chart at the marina cafe
        // walks back to the boat and the cells flow in within a poll cycle.
        // Throttled to never hit the Pi more than once per 5 min.
        startAutoSyncPolling();
        // Web default = the white depth chart (Shane 2026-07-11: "show our
        // new layer as the default on our routing web page"). Cloud cells
        // used to register only when the tracer opened, so a signed-in
        // punter browsing thalassawx.app/plan saw a bare dark map until
        // they tapped Trace. Register at map mount instead — idempotent,
        // manifest-only (blobs still hydrate on demand), and quietly a
        // no-op when signed out (the private bucket refuses: licensing
        // gate stays). Native keeps its Pi-first ladder; a cloud
        // registration there is equally idempotent and covers boats
        // sailing without a Pi aboard.
        void import('../../services/enc/cloudCellSync')
            .then(({ registerCloudCells }) => registerCloudCells())
            .catch(() => {});
        // A punter who lands signed OUT and signs in on the page gets the
        // charts the moment auth flips — without needing to open the tracer.
        let unsubAuth: (() => void) | undefined;
        void import('../../services/supabase')
            .then(({ supabase }) => {
                if (!supabase) return;
                const { data } = supabase.auth.onAuthStateChange((event: string) => {
                    if (event !== 'SIGNED_IN') return;
                    void import('../../services/enc/cloudCellSync')
                        .then(({ registerCloudCells }) => registerCloudCells())
                        .catch(() => {});
                });
                unsubAuth = () => data.subscription.unsubscribe();
            })
            .catch(() => {});
        return () => unsubAuth?.();
    }, []);

    return { encCellCount, encHydration, encNoCoverage };
}
