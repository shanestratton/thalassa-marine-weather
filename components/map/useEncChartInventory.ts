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
import { listCells as listEncCells, listDisplayCells } from '../../services/enc/EncCellMetadata';
import {
    subscribe as subscribeToEnc,
    subscribeHydration as subscribeToEncHydration,
    getHydrationProgress as getEncHydrationProgress,
    hasCoverageFor as encHasCoverageFor,
} from '../../services/enc/EncHazardService';
import { bootstrapEncSamplesIfNeeded, isEncDemoSampleOptedIn } from '../../services/enc/bootstrapEncSamples';
import { startAutoSyncPolling } from '../../services/enc/autoSyncFromPi';
import { backfillCatzocRanges } from '../../services/enc/EncHazardService';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MapHub');

export interface EncChartInventory {
    encCellCount: number;
    encReferenceCellCount: number;
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
    const [encCellCount, setEncCellCount] = useState(() => listDisplayCells().length);
    const [encReferenceCellCount, setEncReferenceCellCount] = useState(
        () => listDisplayCells().filter((cell) => cell.usage === 'reference').length,
    );
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
                // An empty registry is an inventory fact at every zoom, not a
                // viewport inference. Hiding it behind the z11 coverage probe
                // made a fresh production install look charted while the sole
                // Add Charts route led to the held Pi page.
                const displayCells = listDisplayCells();
                const navigationCells = listEncCells();
                if (displayCells.length === 0 || navigationCells.length === 0) {
                    setEncNoCoverage(true);
                    return;
                }
                if (map.getZoom() < 11) {
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
        const unsubscribeCells = subscribeToEnc(probe);
        return () => {
            map.off('moveend', probe);
            unsubscribeCells();
        };
        // mapRef is a stable ref object, so naming it satisfies the linter
        // without changing when this runs — MapHub's original deps were
        // [mapReady, encVisible] and the behaviour is identical.
    }, [mapRef, mapReady, encVisible]);
    useEffect(() => {
        const refresh = () => {
            const cells = listDisplayCells();
            const references = cells.filter((cell) => cell.usage === 'reference');
            // Diagnostic — count only: joining all 172 cloud-cell ids
            // built a ~2.5 KB string per notify and flooded the console
            // during registration storms (2026-07-12 audit).
            log.info(`encCellCount = ${cells.length}`);
            setEncCellCount(cells.length);
            setEncReferenceCellCount(references.length);
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
    // Explicit dev/test/demo preview only. Production never auto-seeds a chart,
    // and demo-tagged cells are excluded from live coverage/hazard confidence.
    useEffect(() => {
        if (isEncDemoSampleOptedIn()) void bootstrapEncSamplesIfNeeded();
        // Check if the user's Bosun Pi is reachable on local wifi and silently pull any AU/NZ/EU cells
        // they've decrypted there. Polling — runs immediately + every 10 min
        // while foregrounded so a user who buys a chart at the marina cafe
        // walks back to the boat and the cells flow in within a poll cycle.
        // Throttled to never hit the Pi more than once per 5 min.
        startAutoSyncPolling();
        // One-off repair for cells imported before CATZOC was derived at
        // import: without it the attribution chip claims "no CATZOC" on
        // charts whose stored M_QUAL actually states a zone of confidence.
        // Local-only and Pi-independent, so it must sit outside the Pi gate;
        // deferred past the boot window like the sync above.
        setTimeout(() => void backfillCatzocRanges(), 12_000);
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
        // And the skipper's OWN published cells, which the curated bucket will
        // never hold: Shane's S-63 Nouméa and Port Vila titles are licensed to
        // him, so they can only ever reach this browser from his own folder.
        void import('../../services/enc/personalCellSync')
            .then(({ syncPersonalCells }) => syncPersonalCells())
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
                    void import('../../services/enc/personalCellSync')
                        .then(({ resetPersonalCellSync, syncPersonalCells }) => {
                            // Drop any manifest cached for the PREVIOUS account
                            // before reading — otherwise a second skipper signing
                            // in on the same browser inherits the first one's
                            // cell list until the 5-minute freshness window ages
                            // out.
                            resetPersonalCellSync();
                            return syncPersonalCells();
                        })
                        .catch(() => {});
                });
                unsubAuth = () => data.subscription.unsubscribe();
            })
            .catch(() => {});
        return () => unsubAuth?.();
    }, []);

    return { encCellCount, encReferenceCellCount, encHydration, encNoCoverage };
}
