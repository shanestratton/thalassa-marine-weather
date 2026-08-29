/**
 * MapboxVelocityOverlay — Bridges leaflet-velocity-ts onto a Mapbox GL map.
 *
 * Data pipeline:
 *   1. Receives the selected model's reactive WindStore grid
 *   2. Converts its current (possibly fractional) forecast frame to U/V records
 *   3. Renders a static wind-speed heatmap below labels
 *   4. Optionally renders animated particles via leaflet-velocity-ts
 *
 * Cleanup: removes the heatmap plus the optional velocity layer/Leaflet overlay.
 *
 * Usage:
 *   <MapboxVelocityOverlay mapboxMap={mapboxInstance} visible />
 */

import React, { useEffect, useRef, useState } from 'react';
import type { WindGrid } from '../../services/weather/windGridEncoding';
import { createLogger } from '../../utils/createLogger';
import { WIND_COLORS, WIND_MAX_MS, windColorForKt } from './windRamp';
import { windGridFrameToVelocityData, type VelocityGribRecord } from './windVelocityFrame';

const log = createLogger('MapboxVelocityOverlay');
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// NOTE: leaflet-velocity-ts is dynamically imported inside useEffect
// because it expects window.L to exist at import time.
// Type declaration is in src/leaflet-velocity-ts.d.ts

interface MapboxVelocityOverlayProps {
    mapboxMap: mapboxgl.Map | null;
    visible: boolean;
    /** Static wind speed stays on; this controls only the animated overlay. */
    particlesEnabled?: boolean;
    windHour?: number;
    windGrid?: WindGrid;
}

// Speed-graded wind particle scale — blue → cyan → green → orange → red →
// pink → magenta → violet. Band table + bucket maths live in ./windRamp so the
// legend shares one definition instead of a hand-mirrored copy.

/**
 * Particle stroke width, in px. THE DIAL — change this one number if the wind
 * field wants more or less presence.
 *
 * Keep it thin, and know why. This canvas is a DOM overlay at z-index 400
 * spanning the whole map (see the container style below), so it draws over
 * LAND as well as water — and it sits above the Mapbox canvas that renders
 * place names. The library also composites additively ('lighter'), so trails
 * accumulate toward white where they cross.
 *
 * The option key is `particlelineWidth` — lowercase 'l' in "line":
 *   leaflet-velocity.js → `this.particleLineWidth = t.particlelineWidth || 1`
 * The code passed `lineWidth: 3.5` for months, which matched nothing, so it
 * silently rendered at the library default of 1. Correcting the key to the
 * literal 3.5 tripled the stroke and swamped every land label (Shane
 * 2026-07-21: "i have lost all of my names from the land area").
 *
 * So 1 is not a fallback here, it is the CHOSEN value: it is what the chart
 * looked like in the screenshot Shane asked to have restored, and it lets the
 * place names read through. The vivid speed ramp is what makes the wind stand
 * out now; the stroke does not have to.
 */
const PARTICLE_LINE_WIDTH = 1;
// Direction is essential even in the broad synoptic view, so Wind begins at
// z3 rather than falling back to a speed-only heatmap. The startup guard below
// protects the third-party renderer from the old delayed-start zoom race.
const MIN_PARTICLE_ZOOM = 3;

/**
 * The z3 synoptic look Shane signed off on. The library multiplies this by
 * pow(viewRadianArea, 0.4), and that area shrinks 4× per zoom level — so a
 * fixed base made particles crawl at ~0.4% of their z3 speed by z12, which
 * read as "the wind died" whenever you zoomed in.
 */
const BASE_VELOCITY_SCALE = 0.015;
const VELOCITY_SCALE_REF_ZOOM = 3;

/**
 * Soften the library's pow(area, 0.4) zoom collapse: area ∝ 4^−z, so the
 * plugin loses 2^0.8 of apparent speed per zoom level and particles were
 * near-motionless by z10. Handing back the FULL 2^0.8 (first attempt) held
 * the z3 apparent speed at every zoom — which turned a 5 kt sea-breeze curl
 * over the bay into a glowing cyclone at z7.6 (Shane 2026-08-04: "looks like
 * a cyclone but there is almost no wind"). 0.45 restores roughly a third of
 * the collapse per level: motion stays alive when zoomed in, but apparent
 * speed eases down with zoom so light air reads as light air.
 */
function zoomCompensatedVelocityScale(mapboxZoom: number): number {
    const z = Math.min(12, Math.max(VELOCITY_SCALE_REF_ZOOM, mapboxZoom));
    return BASE_VELOCITY_SCALE * Math.pow(2, VELOCITY_ZOOM_COMPENSATION * (z - VELOCITY_SCALE_REF_ZOOM));
}

/**
 * How much of the library's zoom collapse to hand back, per level.
 *
 * 0.45 gave 6.5x the base scale by z9, which is why the tight end still read
 * as fast however much the count came down (Shane 2026-08-28: the pre-jump
 * frame — the uncompensated one — "starts out right"). 0.22 gives ~2.3x at
 * z9 and ~3.9x at z12: the "wind died when I zoomed in" failure this
 * compensation exists to prevent stays fixed, but zooming in no longer turns
 * a sea breeze into a gale.
 */
const VELOCITY_ZOOM_COMPENSATION = 0.22;

/**
 * PARTICLE COUNT, the ramp that never existed.
 *
 * leaflet-velocity sizes its population from CANVAS PIXEL AREA:
 *   particuleCount = round(canvas.width * canvas.height * particleMultiplier)
 * That has no zoom term at all, so the same number of particles is drawn
 * whether they cover an ocean or a bay — which is exactly why the tight end
 * looks like a swarm and the wide end looks like texture. Zooming in was
 * concentrating a fixed population into less and less sea.
 *
 * The multiplier now falls to a quarter across z3 -> z9, matching the count
 * ramp's intent. The wide end is untouched: at z3 this is exactly the
 * density that shipped.
 */
const BASE_PARTICLE_MULTIPLIER = 1 / 150;
const PARTICLE_ZOOM_TIGHT = 9;
const PARTICLE_MIN_DENSITY = 0.25;

export function zoomScaledParticleMultiplier(mapboxZoom: number): number {
    if (!Number.isFinite(mapboxZoom)) return BASE_PARTICLE_MULTIPLIER;
    const span = PARTICLE_ZOOM_TIGHT - VELOCITY_SCALE_REF_ZOOM;
    const t = Math.min(1, Math.max(0, (mapboxZoom - VELOCITY_SCALE_REF_ZOOM) / span));
    return BASE_PARTICLE_MULTIPLIER * (1 - (1 - PARTICLE_MIN_DENSITY) * t);
}

// ── Helper: Create velocity layer ─────────────────────────────

function createVelocityLayer(data: VelocityGribRecord[], velocityScale: number, particleMultiplier: number): L.Layer {
    const layer = (L as unknown as Record<string, (...args: unknown[]) => L.Layer>).velocityLayer({
        displayValues: false, // No mouse readout (overlay has pointer-events: none)
        data,
        maxVelocity: WIND_MAX_MS,
        velocityScale,
        particleAge: 60,
        particleMultiplier,
        // 30, was 15: a 66 ms particle step is visible judder on a 60 Hz
        // panel — half of Shane's "shaky" (2026-08-21). 33 ms reads as
        // motion. Still throttled: full-rate RAF measurably warms phones.
        frameRate: 30,
        particlelineWidth: PARTICLE_LINE_WIDTH,
        colorScale: WIND_COLORS,
    });
    // Keep the third-party delayed-start guard attached to every creation
    // path, including a replacement after an unsupported data update.
    guardVelocityLayerStartup(layer);
    return layer;
}

type MutableVelocityLayer = L.Layer & {
    _windy?: { setData: (data: VelocityGribRecord[]) => void; velocityScale?: number; particleMultiplier?: number };
    setData?: (data: VelocityGribRecord[]) => void;
};

/**
 * `leaflet-velocity-ts` creates its Windy instance before it creates the
 * animation bucket used by `Windy.stop()`. A Mapbox zoom can arrive in that
 * small window (particularly when Wind opens at z3), causing the plugin to
 * call `this.animationBucket.clear()` while the bucket is still undefined.
 *
 * The plugin does not expose a lifecycle hook for this, so guard its private
 * startup seam at the one place we create a velocity layer. Once `start()`
 * has run, the original stop implementation remains completely unchanged.
 */
type VelocityWindyInternals = {
    animationBucket?: { clear?: () => void };
    stop?: () => void;
    __thalassaSafeStop?: boolean;
};

type VelocityLayerInternals = MutableVelocityLayer & {
    _windy?: VelocityWindyInternals;
    onDrawLayer?: (...args: unknown[]) => unknown;
    __thalassaStartupGuarded?: boolean;
};

export function guardVelocityLayerStartup(layer: L.Layer): void {
    const internalLayer = layer as VelocityLayerInternals;
    if (internalLayer.__thalassaStartupGuarded || typeof internalLayer.onDrawLayer !== 'function') return;

    internalLayer.__thalassaStartupGuarded = true;
    const originalOnDrawLayer = internalLayer.onDrawLayer;

    internalLayer.onDrawLayer = (...args: unknown[]) => {
        const result = originalOnDrawLayer.call(internalLayer, ...args);
        const windy = internalLayer._windy;
        if (!windy || windy.__thalassaSafeStop || typeof windy.stop !== 'function') return result;

        const originalStop = windy.stop;
        windy.__thalassaSafeStop = true;
        windy.stop = () => {
            // Before the plugin's delayed `start()` call there is no running
            // animation to stop. Returning here avoids its unsafe clear().
            if (!windy.animationBucket) return;
            originalStop.call(windy);
        };

        return result;
    };
}

function removeVelocityLayer(map: L.Map, layer: L.Layer | null): void {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
}

function applyVelocityData(
    map: L.Map,
    layer: L.Layer | null,
    data: VelocityGribRecord[],
    velocityScale: number,
    particleMultiplier: number,
): L.Layer {
    if (!layer) {
        const created = createVelocityLayer(data, velocityScale, particleMultiplier);
        created.addTo(map);
        return created;
    }

    const mutableLayer = layer as MutableVelocityLayer;
    if (mutableLayer._windy) {
        mutableLayer._windy.velocityScale = velocityScale;
        // Re-read on the next start() via the particuleCount getter.
        mutableLayer._windy.particleMultiplier = particleMultiplier;
        mutableLayer._windy.setData(data);
        return layer;
    }
    if (mutableLayer.setData) {
        mutableLayer.setData(data);
        return layer;
    }

    removeVelocityLayer(map, layer);
    const replacement = createVelocityLayer(data, velocityScale, particleMultiplier);
    replacement.addTo(map);
    return replacement;
}

// ── Component ─────────────────────────────────────────────────

export const MapboxVelocityOverlay: React.FC<MapboxVelocityOverlayProps> = ({
    mapboxMap,
    visible,
    particlesEnabled = true,
    windHour = 0,
    windGrid,
}) => {
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const leafletMapRef = useRef<L.Map | null>(null);
    const velocityLayerRef = useRef<L.Layer | null>(null);
    const syncRef = useRef<(() => void) | null>(null);
    const moveRef = useRef<(() => void) | null>(null);
    const resizeRef = useRef<(() => void) | null>(null);
    const zoomEndRef = useRef<(() => void) | null>(null);
    const [particleZoomSupported, setParticleZoomSupported] = useState(() =>
        Boolean(mapboxMap && mapboxMap.getZoom() >= MIN_PARTICLE_ZOOM),
    );
    // Track latest values so the async setup can apply the correct hour
    const windHourRef = useRef(windHour);
    const windGridPropRef = useRef(windGrid);
    windHourRef.current = windHour;
    windGridPropRef.current = windGrid;

    // The OBS wind read is directional at every supported zoom. Wait for the
    // camera to settle before mounting/unmounting the second map so a z3
    // transition cannot fight Mapbox's zoom animation.
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesEnabled) {
            setParticleZoomSupported(false);
            return;
        }

        const updateParticleZoomSupport = () => {
            setParticleZoomSupported(mapboxMap.getZoom() >= MIN_PARTICLE_ZOOM);
        };

        updateParticleZoomSupport();
        // Wait for the camera to settle before starting/stopping the second
        // map. That keeps an animation-layer transition out of Mapbox's zoom
        // animation.
        mapboxMap.on('zoomend', updateParticleZoomSupport);
        return () => {
            mapboxMap.off('zoomend', updateParticleZoomSupport);
        };
    }, [mapboxMap, visible, particlesEnabled]);

    const particlesActive = particlesEnabled && particleZoomSupported;

    // The selected WindStore grid is the sole particle source. This effect
    // covers grid/hour updates after Leaflet setup, including the first frame.
    // If a model switch clears the grid, remove the old model immediately
    // rather than leaving plausible-looking but incorrectly labelled wind.
    useEffect(() => {
        if (!particlesActive) return;
        const leafletMap = leafletMapRef.current;
        if (!leafletMap) return;

        const nextData = windGridFrameToVelocityData(windGrid, windHour);
        if (!nextData) {
            removeVelocityLayer(leafletMap, velocityLayerRef.current);
            velocityLayerRef.current = null;
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
            return;
        }

        try {
            velocityLayerRef.current = applyVelocityData(
                leafletMap,
                velocityLayerRef.current,
                nextData,
                zoomCompensatedVelocityScale(mapboxMap?.getZoom() ?? VELOCITY_SCALE_REF_ZOOM),
                zoomScaledParticleMultiplier(mapboxMap?.getZoom() ?? VELOCITY_SCALE_REF_ZOOM),
            );
            if (overlayRef.current) overlayRef.current.style.opacity = '1';
            syncRef.current?.();
        } catch (err) {
            // Never leave the previous model painted after a renderer update
            // fails. A plausible old field with a newly-selected model label is
            // more dangerous than an honestly empty overlay.
            removeVelocityLayer(leafletMap, velocityLayerRef.current);
            velocityLayerRef.current = null;
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
            log.error('[VelocityOverlay] Failed to apply selected wind grid:', err);
        }
    }, [windHour, windGrid, particlesActive, mapboxMap]);

    // ── Create/destroy particle overlay ──────────────────────────
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesActive) return;

        let cancelled = false;
        let snapTimer: ReturnType<typeof setTimeout> | null = null;
        let sizeObserver: ResizeObserver | null = null;
        let lateBootTimer: ReturnType<typeof setTimeout> | null = null;

        const setup = async () => {
            // Ensure Leaflet is on window BEFORE the plugin loads

            window.L = L;
            await import('leaflet-velocity-ts');

            // leaflet-velocity-ts includes `zoomanim: undefined` in its
            // CanvasLayer event map whenever Leaflet animations are disabled.
            // Leaflet warns once on bind and again on unbind for every mount.
            // Filter only non-functions at the plugin boundary; all valid
            // resize/move/zoom callbacks remain untouched.
            const canvasLayerProto = (
                L as unknown as {
                    CanvasLayer?: {
                        prototype?: {
                            getEvents?: () => Record<string, unknown>;
                            __thalassaFiltersInvalidEvents?: boolean;
                        };
                    };
                }
            ).CanvasLayer?.prototype;
            if (canvasLayerProto?.getEvents && !canvasLayerProto.__thalassaFiltersInvalidEvents) {
                const originalGetEvents = canvasLayerProto.getEvents;
                canvasLayerProto.getEvents = function () {
                    return Object.fromEntries(
                        Object.entries(originalGetEvents.call(this)).filter(
                            ([, listener]) => typeof listener === 'function',
                        ),
                    );
                };
                canvasLayerProto.__thalassaFiltersInvalidEvents = true;
            }

            if (cancelled) return;

            const container = mapboxMap.getContainer();

            // Create overlay div on top of Mapbox
            const div = document.createElement('div');
            div.style.cssText =
                'position:absolute;inset:0;z-index:400;pointer-events:none;opacity:0;transition:opacity 0.4s ease;';
            container.appendChild(div);
            overlayRef.current = div;

            // Create headless Leaflet map (transparent, no tiles, no controls)
            const center = mapboxMap.getCenter();
            const zoom = mapboxMap.getZoom();
            const lMap = L.map(div, {
                center: [center.lat, center.lng],
                zoom: zoom + 1,
                zoomControl: false,
                attributionControl: false,
                dragging: false,
                touchZoom: false,
                doubleClickZoom: false,
                scrollWheelZoom: false,
                boxZoom: false,
                keyboard: false,
                zoomAnimation: false,
                zoomSnap: 0,
            });
            leafletMapRef.current = lMap;

            // Make Leaflet fully transparent
            div.style.background = 'transparent';
            const leafletContainer = div.querySelector('.leaflet-container') as HTMLElement;
            if (leafletContainer) leafletContainer.style.background = 'transparent';
            const tilePane = lMap.getPane('tilePane');
            if (tilePane) tilePane.style.display = 'none';
            const mapPane = lMap.getPane('mapPane');
            if (mapPane) mapPane.style.background = 'transparent';

            // The grid/hour effect may have run before the async Leaflet plugin
            // was ready. Read the refs here to cover that race, including hour 0.
            const initialData = windGridFrameToVelocityData(windGridPropRef.current, windHourRef.current);
            if (initialData) {
                velocityLayerRef.current = applyVelocityData(
                    lMap,
                    null,
                    initialData,
                    zoomCompensatedVelocityScale(mapboxMap.getZoom()),
                    zoomScaledParticleMultiplier(mapboxMap.getZoom()),
                );
            }

            // ── Anchor-point geo-locking (performance optimised) ──
            // MOVE/ZOOM events (every frame during a gesture):
            //   → Lightweight: CSS translate+scale against the last synced view
            //     (no setView — a setView per zoom frame made the plugin kill
            //     and re-seed every particle dozens of times per pinch)
            // MOVEEND (end of gesture — Mapbox fires it after zooms too):
            //   → Full: setView() + measure + record the new baseline
            let _syncing = false;

            // The Leaflet view the canvas was last truly projected at, plus
            // the sub-pixel residual Leaflet rendered it off-centre by.
            let lastSync: { lat: number; lng: number; zoom: number; rx: number; ry: number } | null = null;

            // Full sync — expensive, only at gesture end
            const syncFull = () => {
                if (_syncing || !leafletMapRef.current || !mapboxMap || !overlayRef.current) return;
                _syncing = true;
                try {
                    const c = mapboxMap.getCenter();
                    const zRaw = mapboxMap.getZoom();
                    // The restart this setView triggers re-reads velocityScale,
                    // so hand it the zoom-compensated value first.
                    const windy = (velocityLayerRef.current as MutableVelocityLayer | null)?._windy;
                    if (windy) {
                        windy.velocityScale = zoomCompensatedVelocityScale(zRaw);
                        // The restart re-reads particuleCount, so the density
                        // ramp has to be handed over in the same breath as the
                        // speed one — otherwise zooming in thins the motion
                        // but leaves the swarm.
                        windy.particleMultiplier = zoomScaledParticleMultiplier(zRaw);
                    }
                    leafletMapRef.current.setView([c.lat, c.lng], zRaw + 1, { animate: false });

                    // Measure residual error and correct
                    const mapboxPx = mapboxMap.project([c.lng, c.lat]);
                    const leafletPx = leafletMapRef.current.latLngToContainerPoint([c.lat, c.lng]);
                    let dx = mapboxPx.x - leafletPx.x;
                    let dy = mapboxPx.y - leafletPx.y;
                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                        // A genuine sub-pixel residual is <1 px. Tens of px
                        // means Leaflet is projecting against a STALE cached
                        // container size — the startup half-render band
                        // (Shane's screenshot, 2026-08-21): boot measured the
                        // container while layout was transiently short, and
                        // no resize event ever arrived to heal it (mapbox-gl
                        // resize() early-returns without firing when its own
                        // transform already matches). Re-measure and
                        // re-project HERE, which turns every gesture end into
                        // a heal opportunity instead of a re-application of
                        // the bad translate.
                        leafletMapRef.current.invalidateSize();
                        leafletMapRef.current.setView([c.lat, c.lng], zRaw + 1, { animate: false });
                        const healedPx = leafletMapRef.current.latLngToContainerPoint([c.lat, c.lng]);
                        dx = mapboxPx.x - healedPx.x;
                        dy = mapboxPx.y - healedPx.y;
                    }
                    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                        overlayRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
                    } else {
                        overlayRef.current.style.transform = '';
                    }
                    lastSync = { lat: c.lat, lng: c.lng, zoom: zRaw, rx: -dx, ry: -dy };
                } catch (_) {
                    /* velocity canvas not ready yet */
                }
                _syncing = false;
            };

            // Lightweight camera tracking — cheap, runs on every move/zoom
            // frame. Scales+translates the whole canvas so the field stays
            // geo-locked through a pinch without touching Leaflet (one real
            // re-projection then happens at moveend).
            const trackCamera = () => {
                if (!leafletMapRef.current || !mapboxMap || !overlayRef.current || !lastSync) return;
                try {
                    const cam = mapboxMap.getCenter();
                    const camPx = mapboxMap.project([cam.lng, cam.lat]);
                    const anchorPx = mapboxMap.project([lastSync.lng, lastSync.lat]);
                    const s = Math.pow(2, mapboxMap.getZoom() - lastSync.zoom);
                    const tx = anchorPx.x - camPx.x - s * lastSync.rx;
                    const ty = anchorPx.y - camPx.y - s * lastSync.ry;
                    // transform-origin is the div centre, which is exactly
                    // where the camera centre projects (the div is inset:0).
                    overlayRef.current.style.transform =
                        Math.abs(s - 1) > 0.001
                            ? `translate(${tx}px, ${ty}px) scale(${s})`
                            : `translate(${tx}px, ${ty}px)`;
                } catch (_) {
                    /* ok */
                }
            };

            const onResize = () => {
                leafletMapRef.current?.invalidateSize();
                syncFull();
            };

            // Lightweight tracking on every gesture frame, full sync only at end
            mapboxMap.on('move', trackCamera);
            mapboxMap.on('moveend', syncFull);
            mapboxMap.on('zoom', trackCamera);
            mapboxMap.on('resize', onResize);

            // Observe the container DIRECTLY. The Mapbox 'resize' event alone
            // is not a reliable heal signal: useMapInit's own ResizeObserver
            // calls map.resize(), but mapbox-gl early-returns WITHOUT firing
            // 'resize' when its transform already matches the container — so
            // a boot-time short-layout transient could leave Leaflet's cached
            // size stale forever. invalidateSize() no-ops when nothing
            // changed, so a chatty observer costs nothing.
            if (typeof ResizeObserver !== 'undefined') {
                sizeObserver = new ResizeObserver(() => onResize());
                sizeObserver.observe(container);
            }

            // Single deferred re-sync after zoom/move ends (replaces heavy 200ms×10 interval)
            const onViewEnd = () => {
                if (snapTimer) clearTimeout(snapTimer);
                snapTimer = setTimeout(() => {
                    if (cancelled) return;
                    syncFull();
                    snapTimer = null;
                }, 300);
            };
            mapboxMap.on('zoomend', onViewEnd);
            mapboxMap.on('moveend', onViewEnd);

            syncRef.current = syncFull;
            moveRef.current = trackCamera;
            resizeRef.current = onResize;
            zoomEndRef.current = onViewEnd;

            // Initial sync
            lMap.invalidateSize();
            syncFull();

            // Delayed re-sync — container may not have final dimensions on first mount.
            // Fade in AFTER this final sync so particles don't visibly jump.
            setTimeout(() => {
                if (cancelled) return;
                lMap.invalidateSize();
                syncFull();
                // Fade in only when a selected-model grid has produced a layer.
                if (overlayRef.current && velocityLayerRef.current) overlayRef.current.style.opacity = '1';
            }, 600);

            // Second boot pass: a cold-start layout transient that OUTLIVES
            // the 600 ms retry was exactly the half-render window. Cheap
            // insurance on top of the ResizeObserver + syncFull self-heal.
            lateBootTimer = setTimeout(() => {
                if (cancelled) return;
                lMap.invalidateSize();
                syncFull();
                lateBootTimer = null;
            }, 2000);
        };

        setup().catch((err) => log.error('[VelocityOverlay] Setup failed:', err));

        // ── Cleanup ──────────────────────────────────────────────
        return () => {
            cancelled = true;
            if (snapTimer) {
                clearTimeout(snapTimer);
                snapTimer = null;
            }
            if (lateBootTimer) {
                clearTimeout(lateBootTimer);
                lateBootTimer = null;
            }
            if (sizeObserver) {
                sizeObserver.disconnect();
                sizeObserver = null;
            }

            try {
                if (moveRef.current) {
                    mapboxMap.off('move', moveRef.current);
                    mapboxMap.off('zoom', moveRef.current);
                }
                if (syncRef.current) mapboxMap.off('moveend', syncRef.current);
                if (resizeRef.current) mapboxMap.off('resize', resizeRef.current);
                if (zoomEndRef.current) {
                    mapboxMap.off('zoomend', zoomEndRef.current);
                    mapboxMap.off('moveend', zoomEndRef.current);
                }
            } catch (_) {
                /* ok */
            }
            syncRef.current = null;
            moveRef.current = null;
            resizeRef.current = null;
            zoomEndRef.current = null;

            // Remove heat map from Mapbox
            // Heat map has its own useEffect lifecycle — don't touch it here

            // Remove velocity layer
            try {
                if (velocityLayerRef.current && leafletMapRef.current?.hasLayer(velocityLayerRef.current)) {
                    leafletMapRef.current.removeLayer(velocityLayerRef.current);
                }
            } catch (_) {
                /* ok */
            }
            velocityLayerRef.current = null;

            // Destroy Leaflet map (also detaches its container div)
            try {
                if (leafletMapRef.current) {
                    leafletMapRef.current.remove();
                }
            } catch (_) {
                /* ok */
            }
            leafletMapRef.current = null;

            // Remove overlay div (may already be gone after lMap.remove())
            try {
                if (overlayRef.current?.parentNode) {
                    overlayRef.current.parentNode.removeChild(overlayRef.current);
                }
            } catch (_) {
                /* ok */
            }
            overlayRef.current = null;
        };
    }, [mapboxMap, visible, particlesActive]);

    return null;
};
