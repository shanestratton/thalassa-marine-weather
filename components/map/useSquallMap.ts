/**
 * useSquallMap — Heavy-precip squall detection map.
 *
 * History:
 *   - Pre 2026-04-22: Xweather satellite-IR + radar global tiles.
 *     Decommissioned alongside the rest of the Xweather stack.
 *   - 2026-04-22 → 2026-04-25: Disabled stub — toggling it on did
 *     nothing past the HUD because we hadn't picked a replacement.
 *   - 2026-04-25 (this revision): Powered by Rainbow.ai's precip-global
 *     snapshot tiles, but rendered through SQUALL_COLOR_RAMP so anything
 *     below moderate-heavy rain intensity is invisible. The result is a
 *     "where are the actual thunder cells right now" map — light rain
 *     fades out, only the cells you'd avoid in passage planning remain
 *     visible. Refreshes every 5 minutes (Rainbow's snapshot cadence).
 *
 * The hook also keeps the cyclone spinner overlay so a user looking at
 * an active basin can see both squall cells and the storm centre at
 * once. Cyclone/squall toggles are mutually exclusive in the radial
 * menu (enforced in MapHub) so the user never has dual full-screen
 * overlays competing.
 *
 * Zoom: integer-only 3–8 — Rainbow's 1km native res doesn't add detail
 * past z8 and integer snap stops Mapbox from re-fetching tiles every
 * pinch frame.
 */

import { useEffect, useRef } from 'react';
import { satelliteModeBlocks } from '../../services/networkPolicy';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { cloudOverlayBeforeId, imageryTopIndex } from './imageryOrder';
import { CLOUD_OVERLAY_LAYER, liftCloudOverlay, mountCloudOverlay, removeCloudOverlay } from './cloudOverlay';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { piCache } from '../../services/PiCacheService';
import { SQUALL_COLOR_RAMP } from './isobarLayerSetup';
import { squallSnapshotTimeMs, squallStatusStore, useSquallStatus } from '../../services/weather/squallStatus';
import { subscribeWeatherRefresh } from '../../services/weather/pressureRefresh';

const log = createLogger('SquallMap');

// ── Layer/Source IDs ──
const SQUALL_SOURCE = 'squall-rainbow-source';
const SQUALL_LAYER = 'squall-rainbow-layer';
const SQUALL_HUD_ID = 'squall-map-hud';

/**
 * The satellite cloud half of the squall view, restored 2026-08-21.
 *
 * This layer was always an IR-satellite + precipitation COMPOSITE — cloud
 * tops showing where the weather is organised, precip cells showing where it
 * is falling. The satellite half died on 2026-04-22 as collateral damage
 * when Xweather was decommissioned on cost ("burned through its daily quota
 * in a single dev session"), and that commit promised a NOAA replacement
 * "next session" which never shipped: squall came back precip-only three
 * days later and stayed that way for four months (Shane, 2026-08-21: "our
 * storm layer used to have a satellite cloud layer").
 *
 * NASA GIBS Himawari-9 Band 13 Clean IR restored it on 2026-08-21, and was
 * itself replaced on 2026-08-24 by the Sky section's world cloud layer
 * (OpenWeatherMap clouds_new) at Shane's request. GIBS was a satellite
 * IMAGERY product being asked to behave like an overlay, and it never quite
 * did — see components/map/cloudOverlay.ts for the measurements on both tiles
 * and for what the swap deleted. The current layer is the same one the punter can already
 * turn on from the Sky menu, which is the real argument for it: one cloud
 * field, one appearance, whichever page you are looking at.
 */

/** LAN hop. Fast or not at all — falling through to the cloud beats waiting. */
const PI_BUDGET_MS = 2_500;
/**
 * Budget for the DIRECT snapshot fetch, armed only once that fetch starts.
 *
 * 8 s, not the old shared 3 s: measured warm latency is 0.69-1.76 s and an
 * edge cold start 2.3 s, all on shore broadband, and this runs on a marine
 * link. The refresh cadence is five minutes, so a generous budget costs
 * nothing and a tight one costs the whole layer.
 */
const DIRECT_BUDGET_MS = 8_000;

const SQUALL_MAX_ZOOM = 8;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Rainbow snapshot cadence
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

// ── Hook ──

export function useSquallMap(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    allCyclones?: ActiveCyclone[],
    onSelectStorm?: (storm: ActiveCyclone) => void,
    /** Passage uses squalls as an overlay, without the standalone view's camera takeover. */
    preserveViewport = false,
) {
    const status = useSquallStatus();
    const isSetUp = useRef(false);
    const stormMarkersRef = useRef<mapboxgl.Marker[]>([]);
    const lastRefreshAtRef = useRef<number>(0);
    const loadSessionRef = useRef(0);
    const inflightControllerRef = useRef<AbortController | null>(null);
    /** Detach for the styledata re-assert that keeps the cloud up. */
    const styleWatchRef = useRef<(() => void) | null>(null);
    // Keep a passage-activated squall view as an overlay until it is turned
    // off. Closing the HUD alone must not trigger a delayed camera takeover.
    const overlaySessionRef = useRef(false);
    if (!visible) overlaySessionRef.current = false;
    else if (preserveViewport) overlaySessionRef.current = true;
    const preserveCamera = overlaySessionRef.current;

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible || preserveCamera) return;
        const ausNzMin = (map as mapboxgl.Map & { __ausNzMinZoom?: number }).__ausNzMinZoom ?? 3;
        const minInt = Math.round(ausNzMin);
        const previousMax = map.getMaxZoom();
        const previousMin = map.getMinZoom();
        map.setMinZoom(minInt);
        map.setMaxZoom(SQUALL_MAX_ZOOM);
        // Zoom out about what is on screen; the centre stays put. Obs opens
        // where the location box points (the vessel, or a chosen place such
        // as Hawaii), and switching a layer on must never fly the chart off
        // it, to the phone's GPS or anywhere else (Shane 2026-10-06).
        map.easeTo({ zoom: minInt, duration: 800 });
        const onZoomEnd = () => {
            const zoom = map.getZoom();
            const snapped = Math.max(minInt, Math.min(Math.round(zoom), SQUALL_MAX_ZOOM));
            if (Math.abs(zoom - snapped) > 0.05) map.easeTo({ zoom: snapped, duration: 150 });
        };
        map.on('zoomend', onZoomEnd);
        return () => {
            map.off('zoomend', onZoomEnd);
            // Restore only constraints still owned by squall: a cyclone or
            // another weather layer may already have taken over the camera.
            if (map.getMaxZoom() === SQUALL_MAX_ZOOM) map.setMaxZoom(previousMax);
            if (map.getMinZoom() === minInt) map.setMinZoom(previousMin);
        };
    }, [mapRef, mapReady, visible, preserveCamera]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        const loadSession = ++loadSessionRef.current;
        const isCurrentLoadSession = () => visible && loadSessionRef.current === loadSession;
        let mountedSnapshot: number | null = null;
        let tileFailure = false;
        let tileTimer: ReturnType<typeof setTimeout> | undefined;
        const failTiles = () => {
            if (!isCurrentLoadSession()) return;
            tileFailure = true;
            clearTimeout(tileTimer);
            squallStatusStore.set({
                phase: 'error',
                tilesReady: false,
                error: 'Squall precipitation tiles unavailable',
            });
        };
        const onSourceLoading = (event: mapboxgl.MapSourceDataEvent) => {
            if (event.sourceId !== SQUALL_SOURCE || !isCurrentLoadSession() || tileFailure) return;
            squallStatusStore.set({ phase: 'loading', tilesReady: false });
            if (!tileTimer) tileTimer = setTimeout(failTiles, 20_000);
        };
        const onSourceData = (event: mapboxgl.MapSourceDataEvent) => {
            if (event.sourceId === SQUALL_SOURCE && event.sourceDataType === 'error') {
                failTiles();
                return;
            }
            if (
                event.sourceId !== SQUALL_SOURCE ||
                event.sourceDataType !== 'content' ||
                !isCurrentLoadSession() ||
                tileFailure
            )
                return;
            if (event.isSourceLoaded && map.isSourceLoaded(SQUALL_SOURCE)) {
                clearTimeout(tileTimer);
                tileTimer = undefined;
                squallStatusStore.set({ phase: squallStatusStore.get().error ? 'error' : 'ready', tilesReady: true });
            }
        };
        const onMapError = (event: mapboxgl.ErrorEvent & { sourceId?: string }) => {
            if (event.sourceId === SQUALL_SOURCE) failTiles();
        };
        const cancelInflightLoad = () => {
            const controller = inflightControllerRef.current;
            if (!controller) return;
            controller.abort();
            if (inflightControllerRef.current === controller) {
                inflightControllerRef.current = null;
            }
        };
        const startLoad = () => {
            // Clouds go up FIRST and unconditionally — they need nothing from
            // Rainbow, so they must not wait on (or be lost to) its fetch.
            ensureSatelliteLayer(map, loadSession, () => loadSessionRef.current);
            if (inflightControllerRef.current) {
                log.info('Squall snapshot fetch already in flight — skipping');
                return;
            }
            const controller = new AbortController();
            inflightControllerRef.current = controller;
            squallStatusStore.set({ phase: 'loading', error: null });
            void loadSquallTiles(map, lastRefreshAtRef, controller, isCurrentLoadSession, (snapshot) => {
                if (
                    mountedSnapshot === snapshot &&
                    map.getSource(SQUALL_SOURCE) &&
                    squallStatusStore.get().tilesReady
                ) {
                    squallStatusStore.set({ phase: 'ready' });
                    return false;
                }
                mountedSnapshot = snapshot;
                tileFailure = false;
                clearTimeout(tileTimer);
                tileTimer = setTimeout(failTiles, 20_000);
                squallStatusStore.set({ tilesReady: false });
                return true;
            }).finally(() => {
                if (inflightControllerRef.current === controller) {
                    inflightControllerRef.current = null;
                }
            });
        };

        // ── Teardown when hidden ──
        if (!visible) {
            cancelInflightLoad();
            styleWatchRef.current?.();
            styleWatchRef.current = null;
            cleanupLayers(map);
            isSetUp.current = false;
            for (const m of stormMarkersRef.current) m.remove();
            stormMarkersRef.current = [];
            squallStatusStore.reset();
            return;
        }

        squallStatusStore.reset();
        lastRefreshAtRef.current = 0;
        map.on('sourcedataloading', onSourceLoading);
        map.on('sourcedata', onSourceData);
        map.on('error', onMapError);

        // ── Setup ──
        if (!isSetUp.current) {
            // Top-left HUD removed 2026-04-25 — redundant with the
            // bottom-left SquallLegend chip's status pill which already
            // shows LIVE / Nm / Nh freshness. Two HUDs saying the same
            // thing 200px apart was clutter.
            isSetUp.current = true;
            log.warn('⛈️ Squall map active — fetching Rainbow snapshot');

            // Kick off the first Rainbow load.
            startLoad();

            // KEEP the cloud up for as long as storms are on.
            //
            // Before this, the IR layer was mounted exactly twice: once here
            // and once every five minutes on the refresh timer. A style event
            // in between — a basemap swap, the ENC stack mounting, the
            // imagery layers arriving after us — could drop or bury it, and
            // nothing noticed until the next refresh. That is the "cloud
            // layer is not there" on a first open (Shane 2026-08-23).
            //
            // Coalesced, because styledata fires in bursts (every tile load,
            // every setData); and CONDITIONAL, because an unconditional write
            // in a styledata handler re-fires itself — the ~8 Hz loop this
            // file's neighbours all carry warnings about.
            let pendingId: number | null = null;
            const onStyleData = () => {
                if (pendingId !== null) return;
                pendingId = window.setTimeout(() => {
                    pendingId = null;
                    if (!isSetUp.current) return;
                    ensureSatelliteLayer(map, loadSession, () => loadSessionRef.current);
                }, 250);
            };
            map.on('styledata', onStyleData);
            // Detach BOTH: a pending tick outlives map.off() and would fire
            // against a torn-down view.
            styleWatchRef.current = () => {
                map.off('styledata', onStyleData);
                if (pendingId !== null) {
                    window.clearTimeout(pendingId);
                    pendingId = null;
                }
            };
        }

        // Auto-refresh every 5 min so the user always sees recent cells.
        const stopRefresh = subscribeWeatherRefresh(() => {
            const age = Date.now() - lastRefreshAtRef.current;
            if (!lastRefreshAtRef.current || age < 0 || age >= REFRESH_INTERVAL_MS || squallStatusStore.get().error)
                startLoad();
        });

        return () => {
            if (loadSessionRef.current === loadSession) {
                loadSessionRef.current += 1;
            }
            cancelInflightLoad();
            stopRefresh();
            clearTimeout(tileTimer);
            map.off('sourcedataloading', onSourceLoading);
            map.off('sourcedata', onSourceData);
            map.off('error', onMapError);
            squallStatusStore.reset();
            styleWatchRef.current?.();
            styleWatchRef.current = null;
            // Reset the setup latch here too, not only in the !visible branch:
            // a StrictMode mount -> cleanup -> remount with visible still true
            // otherwise detaches the watcher and then skips the whole setup
            // block, so nothing re-establishes it.
            isSetUp.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);

    // ── Cyclone spinners ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible || !allCyclones?.length) {
            for (const m of stormMarkersRef.current) m.remove();
            stormMarkersRef.current = [];
            return;
        }

        for (const m of stormMarkersRef.current) m.remove();
        stormMarkersRef.current = [];

        for (const cyclone of allCyclones) {
            const el = createSquallSpinnerEl(cyclone);
            el.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                el.style.display = 'none';
                onSelectStorm?.(cyclone);
            });
            const marker = new mapboxgl.Marker({ element: el })
                .setLngLat([cyclone.currentPosition.lon, cyclone.currentPosition.lat])
                .addTo(map);
            stormMarkersRef.current.push(marker);
        }
        log.info(`🌀 Added ${allCyclones.length} cyclone spinner(s) to squall map`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady, allCyclones?.length]);

    // Tick the HUD's age display every minute — purely cosmetic so the
    // user can tell at a glance whether the data is still fresh.
    // HUD age tick removed — SquallLegend chip handles freshness display now.
    return status;
}

// ── Rainbow snapshot fetcher + tile source mounting ──

/**
 * Fetch the latest Rainbow precip-global snapshot ID and (re)mount
 * the squall tile layer using it. Routes through Pi cache when the
 * boat network is up so the fleet shares one snapshot fetch.
 *
 * Tiles themselves go through Mapbox GL's transformRequest →
 * passthroughTileUrl path automatically (configured in useMapInit), so
 * there's nothing to wire on the tile-side caching.
 */
async function loadSquallTiles(
    map: mapboxgl.Map,
    lastRefreshAtRef: React.MutableRefObject<number>,
    controller: AbortController,
    isCurrentLoadSession: () => boolean,
    prepareMount: (snapshot: number) => boolean,
): Promise<void> {
    const isCurrent = () => !controller.signal.aborted && isCurrentLoadSession();
    if (!isCurrent()) return;

    const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
    if (!supabaseUrl) {
        log.warn('Supabase URL missing — cannot fetch Rainbow snapshot');
        squallStatusStore.set({ phase: 'error', error: 'Squall service unavailable' });
        return;
    }

    // Radar is raster tiles by the dozen — nothing about it belongs on a
    // satellite link. No snapshot means mountSquallLayer is never reached.
    if (satelliteModeBlocks('raster')) {
        log.info('Satellite Mode — squall radar not fetched');
        squallStatusStore.set({ phase: 'error', error: 'Squall precipitation paused in satellite mode' });
        return;
    }

    // Use the same snapshot endpoint the rain layer hits. Pi
    // passthrough so the boat fleet shares one fetch.
    const upstream = `${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot&layer=precip-global`;

    // THE TIMEOUT USED TO COVER BOTH ATTEMPTS, WHICH IS WHY THE PRECIP HALF
    // NEVER LOADED (Shane 2026-08-23: "the squall layer is not working").
    //
    // One `setTimeout(() => controller.abort(), 3000)` was armed HERE, before
    // the Pi attempt, and the direct fetch below then ran on whatever was
    // left of it. A Pi that is configured but out of range burns its full
    // read timeout first, so the direct fetch was aborted the instant it
    // started — and even with no Pi at all the margin was thin: the snapshot
    // endpoint measured 0.69-1.76 s warm and 2.3 s on an edge cold start
    // (2026-08-23, four samples on a good shore connection). On the boat's
    // link there was nothing left to spend.
    //
    // The backend was never the problem: the same endpoint returns
    // {"snapshot":…} 200 and a real 9.5 kB dbz_u8 PNG tile.
    //
    // Each attempt now gets its OWN budget. The controller still exists for
    // teardown (Chart → Plan), which is a different concern from a slow link
    // and should never have shared a clock with it.
    let snapshot: number | null = null;
    const t0 = Date.now();
    try {
        // Pi first over the pinned transport, then direct. This used to be
        // `fetch(piUrl ?? upstream)`, which could not present the Pi's
        // self-signed cert and therefore threw on iOS whenever the Pi was
        // reachable — taking the snapshot with it instead of going direct.
        // The Pi is a LAN hop: if it cannot answer inside PI_BUDGET_MS it is
        // not going to, and the cloud is the better bet.
        const piData = await piCache.passthroughJson<{ snapshot?: number | null }>(
            upstream,
            SNAPSHOT_TTL_MS,
            'rainbow-snapshot',
            PI_BUDGET_MS,
        );
        if (!isCurrent()) return;
        let data = piData;
        if (!data) {
            // Fresh budget, armed only now — this is the fix.
            const timer = setTimeout(() => controller.abort(), DIRECT_BUDGET_MS);
            try {
                const res = await fetch(upstream, { signal: controller.signal });
                if (!isCurrent()) return;
                if (!res.ok) {
                    log.warn(`Rainbow snapshot HTTP ${res.status} after ${Date.now() - t0}ms`);
                    squallStatusStore.set({ phase: 'error', error: 'Squall snapshot refresh unavailable' });
                    return;
                }
                data = await res.json();
            } finally {
                clearTimeout(timer);
            }
        }
        if (!isCurrent()) return;
        snapshot = data?.snapshot ?? null;
    } catch (err) {
        if (isCurrentLoadSession())
            squallStatusStore.set({ phase: 'error', error: 'Squall snapshot refresh unavailable' });
        if (!controller.signal.aborted) {
            log.warn(`Rainbow snapshot fetch failed after ${Date.now() - t0}ms`, err);
        } else {
            // Distinguish "we ran out of time" from "the view was torn down".
            // Both aborted the same controller and both logged the same line,
            // which is part of why this took a report to find.
            log.warn(
                `Rainbow snapshot aborted after ${Date.now() - t0}ms ` +
                    `(${isCurrentLoadSession() ? `timed out — budget ${DIRECT_BUDGET_MS}ms` : 'view torn down'})`,
            );
        }
        return;
    }

    if (!Number.isSafeInteger(snapshot) || !snapshot || snapshot <= 0) {
        log.warn(`Rainbow snapshot empty after ${Date.now() - t0}ms`);
        squallStatusStore.set({ phase: 'error', error: 'Squall snapshot unavailable' });
        return;
    }
    if (!isCurrent()) return;

    const snapshotTimeMs = squallSnapshotTimeMs(snapshot);
    const previousTime = squallStatusStore.get().snapshotTimeMs;
    if (snapshotTimeMs !== null && previousTime !== null && snapshotTimeMs < previousTime) {
        squallStatusStore.set({ phase: 'error', error: 'Squall refresh returned an older snapshot' });
        return;
    }
    try {
        if (prepareMount(snapshot)) mountSquallLayer(map, supabaseUrl, snapshot);
    } catch {
        squallStatusStore.set({ phase: 'error', tilesReady: false, error: 'Squall precipitation tiles unavailable' });
        return;
    }
    lastRefreshAtRef.current = Date.now();
    squallStatusStore.set({ snapshotTimeMs, fetchedAtMs: lastRefreshAtRef.current });
}

/**
 * Mount the satellite cloud layer. INDEPENDENT of Rainbow by design.
 *
 * This lived inside mountSquallLayer when it was restored earlier today,
 * which coupled it to the Rainbow snapshot fetch — and that path has five
 * early returns (no Supabase URL, fetch throw, 3 s timeout, non-OK status,
 * empty snapshot). Any one of them meant no clouds either, even though GIBS
 * needs nothing from Rainbow: no key, no proxy, no snapshot. Shane saw
 * exactly that on 2026-08-21 ("the storms layer does not show the satellite
 * info").
 *
 * The two halves of this composite now fail independently, which is the
 * whole point of it being a composite.
 */
/**
 * Put the cloud up, and KEEP it up.
 *
 * "when i first open it up the info box is there but it disappears. when i go
 * back in, it stays. also the cloud layer is not there" (Shane 2026-08-23).
 * Both halves of that are the same shape — a first-open ordering race — and
 * for the cloud it is this: mountSatelliteLayerNow calls addSource/addLayer
 * immediately and wraps the whole thing in a try/catch that only LOGS. On a
 * first open the style can still be loading (mapbox throws) or the imagery
 * layers this anchors against may not be added yet (the anchor silently
 * degrades and the opaque base paints over the cloud). Either way nothing
 * retried for five minutes, until the refresh timer came round — which is
 * exactly why the second open worked.
 *
 * So: wait for the style, then mount; and re-assert on styledata.
 *
 * The re-assert is CONDITIONAL and self-limiting, deliberately. This file's
 * neighbours carry scars from an unconditional styledata handler that wrote
 * every tick and re-fired itself at ~8 Hz. Here, a present, correctly-placed
 * layer means the handler does nothing at all, and the one write it can make
 * (mount, or move above the imagery) puts the layer in the state the handler
 * tests for — so it settles after one pass.
 */
function ensureSatelliteLayer(map: mapboxgl.Map, session: number, liveSession: () => number): void {
    // WHOLE BODY GUARDED. The first cut of this called map.isStyleLoaded()
    // bare, and it is the FIRST statement of startLoad — so on any map object
    // without that method the TypeError escaped the effect body and took the
    // Rainbow precip load down with it. That is the two-halves-coupled failure
    // StormLayerRestoration.test.ts exists as a tripwire against, reintroduced
    // in the opposite direction (it broke 4 tests before it was caught).
    try {
        // addSource/addLayer throw outright before the style is ready.
        if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
            map.once('idle', () => {
                // Gate on the LIVE LOAD SESSION, not on the source's presence.
                // The first version read `if (map.getSource(...)) return`,
                // which is backwards: it bailed when the layer was already up
                // and proceeded when cleanupLayers had torn it down. Tapping a
                // storm spinner while this was armed switches to the cyclone
                // view and then mounts our GIBS raster on top of ITS satellite
                // layer — two IR clouds, one of them nobody asked for.
                // loadSessionRef is already bumped on teardown, so this needs
                // no new machinery to become cancellable.
                if (liveSession() !== session) return;
                ensureSatelliteLayer(map, session, liveSession);
            });
            return;
        }
        if (!map.getLayer(CLOUD_OVERLAY_LAYER)) {
            mountSatelliteLayerNow(map);
            return;
        }
        // Present — but is it under the opaque imagery? An IR layer below the
        // satellite base is invisible, which reads to the user as "not there".
        const layers = map.getStyle()?.layers ?? [];
        const irIdx = layers.findIndex((l) => l.id === CLOUD_OVERLAY_LAYER);
        const imageryIdx = imageryTopIndex(layers);
        if (irIdx >= 0 && imageryIdx > irIdx) {
            liftCloudOverlay(map, cloudOverlayBeforeId(layers));
            log.warn(`☁️ Cloud layer was buried under imagery — lifted above layer ${imageryIdx}`);
        }
        // Same burial check for the PRECIP half — the actual squall cells.
        // A basemap swap re-appends the opaque imagery on top, and this
        // styledata re-assert is the only thing that can notice for the
        // five minutes until the next refresh.
        const layersNow = map.getStyle()?.layers ?? [];
        const squallIdx = layersNow.findIndex((l) => l.id === SQUALL_LAYER);
        if (squallIdx >= 0 && imageryTopIndex(layersNow) > squallIdx) {
            map.moveLayer(SQUALL_LAYER, squallBeforeId(layersNow));
            log.warn('⛈️ Squall cells were buried under imagery — lifted');
        }
    } catch (err) {
        log.warn('Cloud layer ensure failed — continuing with precip only', err);
    }
}

/**
 * Anchor for the PRECIP cells: one slot ABOVE the IR cloud.
 *
 * mapbox inserts BENEATH beforeId, so anchoring the cells at the cloud's own
 * id would tuck them under it — and OWM's clouds_new paints its heaviest
 * alpha exactly where active cells are, washing out the one thing this view
 * exists to show. Taking the layer above the cloud keeps the cells over the
 * IR and still below whatever the cloud itself was anchored beneath (labels,
 * ENC), so coastlines and names stay readable. Falls back to the cloud's own
 * ladder when no cloud is up.
 */
function squallBeforeId(layers: Array<{ id: string }>): string | undefined {
    const cloudIdx = layers.findIndex((l) => l.id === CLOUD_OVERLAY_LAYER);
    if (cloudIdx < 0) return cloudOverlayBeforeId(layers);
    // Cloud is topmost — nothing to sit beneath, so the cells go on top.
    return layers[cloudIdx + 1]?.id;
}

function mountSatelliteLayerNow(map: mapboxgl.Map): void {
    // Delegates to the ONE cloud implementation (components/map/cloudOverlay).
    // This file used to own its own copy — NASA GIBS, with a raster-color ramp
    // to manufacture alpha out of an opaque tile — while useCycloneLayer owned
    // a second one built on satellite IR products. Converting only this half on
    // 2026-08-24 left the storm page still showing satellite, which is the
    // whole argument for there being one.
    const styleLayers = map.getStyle()?.layers ?? [];
    mountCloudOverlay(map, cloudOverlayBeforeId(styleLayers));
}

/**
 * Add (or replace) the Mapbox raster source + layer for the current
 * snapshot. We tear down the previous source/layer and add fresh ones
 * so Mapbox actually re-fetches tiles — `setData` on a raster source
 * doesn't exist, and just changing the URL string in setTiles isn't
 * universally supported across Mapbox GL versions.
 */
function mountSquallLayer(map: mapboxgl.Map, supabaseUrl: string, snapshot: number): void {
    // Tile URL: dbz_u8 grayscale encoding so we can apply our own
    // SQUALL_COLOR_RAMP via raster-color in the layer paint. forecast=0
    // means "current snapshot" — no forecast offset for the squall view.
    const tileUrl =
        `${supabaseUrl}/functions/v1/proxy-rainbow?action=tile&layer=precip-global` +
        `&snapshot=${snapshot}&forecast=0&z={z}&x={x}&y={y}&color=dbz_u8`;

    // Remove existing layer/source (if any) so the next addSource fetches
    // fresh tiles for the new snapshot.
    try {
        if (map.getLayer(SQUALL_LAYER)) map.removeLayer(SQUALL_LAYER);
        if (map.getSource(SQUALL_SOURCE)) map.removeSource(SQUALL_SOURCE);
    } catch (err) {
        log.warn('Squall pre-mount cleanup error', err);
    }

    map.addSource(SQUALL_SOURCE, {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        minzoom: 2,
        // Rainbow's 1km native res — overzoom past z8 looks identical
        // and saves a 16x tile request multiplication per zoom step.
        maxzoom: 8,
    });

    // Anchor via the imagery-aware ladder, NOT the first symbol layer. The
    // bare first-symbol anchor put the cells above ENC but BELOW the
    // top-appended opaque satellite base — and squall pins the camera to
    // z3–8 where no ENC cell ever mounts, so MapHub's ordering self-heal
    // (gated on encBottom) could never run. The cells rendered perfectly,
    // under the imagery, while the legend said "Live" (Shane 2026-08-27:
    // "it is not working at all"). Same fix lightning got on 2026-08-23 —
    // one slot higher, so the cells sit ABOVE the IR cloud they composite
    // with rather than under its heaviest alpha.
    const styleLayers = map.getStyle()?.layers ?? [];
    const beforeId = squallBeforeId(styleLayers);

    map.addLayer(
        {
            id: SQUALL_LAYER,
            type: 'raster',
            source: SQUALL_SOURCE,
            paint: {
                'raster-opacity': 1,
                'raster-fade-duration': 0,
                'raster-color': SQUALL_COLOR_RAMP,
                'raster-color-mix': [1, 0, 0, 0], // R channel = value (R=G=B in grayscale)
                'raster-color-range': [0, 1],
            },
        },
        beforeId,
    );
}

// ── Cleanup ──

function cleanupLayers(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(SQUALL_LAYER)) map.removeLayer(SQUALL_LAYER);
        if (map.getSource(SQUALL_SOURCE)) map.removeSource(SQUALL_SOURCE);
        removeCloudOverlay(map);
        const hud = map.getContainer().querySelector(`#${SQUALL_HUD_ID}`);
        if (hud) hud.remove();
    } catch (err) {
        log.warn('Squall cleanup error:', err);
    }
    log.info('🧹 Squall layers cleaned up');
}

// (Top-left HUD + updateHudAge removed 2026-04-25 — replaced by the
// SquallLegend chip in the bottom-left corner. Kept SQUALL_HUD_ID as
// a constant in cleanupLayers in case any stale HUD from a previous
// build is still lingering in the DOM.)

// ── Cyclone spinner ──

function createSquallSpinnerEl(cyclone: ActiveCyclone): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        cursor: pointer;
        pointer-events: auto;
        z-index: 500;
        filter: drop-shadow(0 2px 8px rgba(255,60,60,0.5));
    `;

    const name = cyclone.name || cyclone.sid || '?';
    const windKts = cyclone.currentPosition.windKts ?? cyclone.maxWindKts;
    const catColor = windKts >= 64 ? '#ff4444' : windKts >= 34 ? '#ffa500' : '#22c55e';

    const nameLabel = document.createElement('div');
    nameLabel.style.cssText = `
        font-size: 10px; font-weight: 800; color: #fff;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
        background: rgba(0,0,0,0.55); padding: 2px 8px;
        border-radius: 6px; backdrop-filter: blur(4px);
        margin-bottom: 3px; white-space: nowrap;
        text-transform: uppercase; letter-spacing: 0.04em;
    `;
    nameLabel.textContent = name;
    el.appendChild(nameLabel);

    const spinnerContainer = document.createElement('div');
    spinnerContainer.style.cssText = `
        width: 32px; height: 32px;
        display: flex; align-items: center; justify-content: center;
    `;

    const svgStr = `<svg viewBox="0 0 100 100" width="30" height="30"
         style="animation: cyclone-eye-spin 4s linear infinite;">
        <circle cx="50" cy="50" r="8" fill="${catColor}" stroke="#000" stroke-width="2"/>
        <g fill="${catColor}" opacity="0.8" stroke="#000" stroke-width="1">
            <path d="M54 42 C58 28, 68 10, 82 8 C90 6, 96 14, 94 24 C92 32, 84 36, 74 34 C68 33, 62 36, 58 42 Z"/>
            <path d="M46 58 C42 72, 32 90, 18 92 C10 94, 4 86, 6 76 C8 68, 16 64, 26 66 C32 67, 38 64, 42 58 Z"/>
            <path d="M58 54 C72 58, 90 68, 92 82 C94 90, 86 96, 76 94 C68 92, 64 84, 66 74 C67 68, 64 62, 58 58 Z"/>
            <path d="M42 46 C28 42, 10 32, 8 18 C6 10, 14 4, 24 6 C32 8, 36 16, 34 26 C33 32, 36 38, 42 42 Z"/>
        </g>
    </svg>`;
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgStr, 'image/svg+xml');
    const svgNode = svgDoc.documentElement;
    if (svgNode && svgNode.nodeName === 'svg') {
        spinnerContainer.appendChild(document.importNode(svgNode, true));
    }
    el.appendChild(spinnerContainer);

    return el;
}
