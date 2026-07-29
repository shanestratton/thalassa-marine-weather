/**
 * useTracerTraceLayer — draws the graded trace on its own Mapbox source.
 * ('route-line' belongs to the passage planner; this is deliberately separate.)
 *
 * Extracted from MapHub as a pure text move. ~387 lines, the largest single
 * unit in the tracer, and the one where a mechanical error is caught by no
 * automated gate in this repo — there is no test that renders MapHub.
 *
 * CALL POSITION IS THE ENTIRE Z-ORDER STORY. The six trace layers are added
 * with NO beforeId, so they land wherever the top of the style happened to be
 * at install time. This hook must be called:
 *   - AFTER useTracerGhostLanes (a real data dependency — ghostLanes feeds the
 *     feature build and the dep array), and
 *   - BEFORE useTracerFrameMarkers and useTracerPinMarkers, and
 *   - ABOVE every other map-layer hook in MapHub.
 * promoteTraceLayers is the only thing that re-asserts order afterwards, and
 * it is what stops ENC and imagery — which mount asynchronously and land on
 * top — from burying the line. That was the "waypoints but no line" bug.
 *
 * DO NOT REORDER sync()'s INTERNALS. The trace-line setData must stay ABOVE
 * the issue loop. The whole of sync() shares one bare catch, so decoration
 * must never be able to take the payload down with it. Relatedly,
 * 'trace-dest-hint' is the ONLY source/layer pair installed BELOW the issue
 * loop; every other install is above it. That asymmetry is invisible without
 * reading line numbers, and it is why a throw in the issue loop costs the dest
 * hint and the promote but not the line itself.
 *
 * layersUp() must keep checking exactly three of the six layers. Stricter
 * risks reopening the ~8 Hz styledata self-feeding loop, because sync's own
 * setData emits styledata. Looser and nothing heals after a style switch.
 *
 * `map` is captured ONCE at effect time, and every deferred path — the
 * styledata heal, the 300 ms firstTry interval, the map.once('idle') promote —
 * writes to THAT capture, never to mapRef.current. The one exception is the
 * 200 ms wait-for-map poll, which reads mapRef.current at FIRE time because
 * that is the whole point of it. Do not convert either direction.
 *
 * traceLayerNudge is a pure re-entry token: incremented only by that poll,
 * read only in the dep array. It exists because mapReady is declared ~1,300
 * lines below in MapHub and cannot be named in this dep array. Drop it and the
 * permanent-null-map bail comes back.
 *
 * traceIdlePromoteRef stays a hook-local useRef so the one-shot latch is
 * per-MapHub-instance. Module scope would share it between the /plan tracer
 * and the chart tracer, which are separate stacks.
 *
 * The addLayer order here and TRACE_LAYER_IDS in ./isobarLayerSetup are two
 * hand-maintained orderings that must agree — 'trace-line-glow' before
 * 'trace-line-core' is not incidental.
 *
 * The logger name stays 'MapHub' verbatim so the device line
 * "[trace] sync failed — line may be unpainted" is byte-identical; it is the
 * only observable signal for that failure and it is grepped in the Xcode
 * console. warn(), never info() — info is silenced in prod.
 *
 * KNOWN HOLES, ALL PRE-EXISTING, ALL LEFT ALONE: the map.once('idle') promote
 * is never removed and outlives unmount; nothing ever removes the trace-*
 * sources or layers; the getSource casts are unguarded; and the `as never`
 * casts on the feature arrays hide GeoJSON shape drift from tsc. Each needs
 * its own commit — none of them belongs in a move.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { promoteTraceLayers } from './isobarLayerSetup';
import { createLogger } from '../../utils/createLogger';
import type { TraceLegVerdict, GhostLane } from '../../services/routeTracer';

const log = createLogger('MapHub');

export interface TracerTraceLayerDeps {
    /** Ref OBJECT. Read at EFFECT time into a local `map`, and separately at
     *  FIRE time inside the wait-for-map poll. Both timings are load-bearing. */
    mapRef: React.RefObject<mapboxgl.Map | null>;
    coordCaptureMode: boolean;
    capturedCoords: { lat: number; lon: number }[];
    legVerdicts: Array<TraceLegVerdict | null>;
    /** From useTracerGhostLanes — which is why that hook is called first. */
    ghostLanes: GhostLane[];
    traceOrigin: { lat: number; lon: number; name: string } | null;
    traceDest: { lat: number; lon: number; name: string } | null;
}

export function useTracerTraceLayer({
    mapRef,
    coordCaptureMode,
    capturedCoords,
    legVerdicts,
    ghostLanes,
    traceOrigin,
    traceDest,
}: TracerTraceLayerDeps): void {
    /**
     * Re-entry ticket for the trace-layer sync effect when it ran before the
     * Mapbox object existed (cold PLAN -> map open of a saved route). Declared
     * HERE, above that effect, because `mapReady` lives ~1300 lines further
     * down and cannot be named in a dep array evaluated during this render.
     * Incremented by the effect's own wait-for-map poll; never read elsewhere.
     */
    const [traceLayerNudge, setTraceLayerNudge] = useState(0);
    // One pending idle-promote at a time — see the use site in sync().
    const traceIdlePromoteRef = useRef(false);
    // Draw the graded legs on a dedicated source ('route-line' belongs to the
    // passage planner). Idempotent ensure() re-adds after a basemap style
    // switch drops custom layers; styledata re-syncs.
    useEffect(() => {
        // WAIT FOR THE MAP, don't just bail.
        //
        // NOT the cause of the missing trace line — that was the layer-vs-
        // source readiness check further down, and this effect runs BEFORE the
        // pin-marker effect, so a null map would have cost the waypoints too.
        // A latent hole closed while in here: `return` on a null map is
        // permanent, because the deps are all trace data and none of them
        // change again once a saved route has loaded.
        //
        // It cannot simply depend on mapReady — that state is declared far
        // BELOW this effect (~line 2790), so naming it in a dep array
        // evaluated during render is a temporal-dead-zone reference. Hence a
        // poll: cheap, self-cancelling, and it makes the effect correct
        // regardless of which side of the race the map lands on.
        //
        // The pins survived this because they are DOM markers reconciled by a
        // separate effect, which is exactly why the bug reads as "waypoints
        // but no line" rather than "nothing drew".
        const map = mapRef.current;
        if (!map) {
            const waitForMap = window.setInterval(() => {
                if (!mapRef.current) return;
                window.clearInterval(waitForMap);
                setTraceLayerNudge((n) => n + 1); // re-enter with a live map
            }, 200);
            return () => window.clearInterval(waitForMap);
        }
        const layersUp = (): boolean =>
            !!map.getLayer('trace-line-core') &&
            !!map.getLayer('trace-line-glow') &&
            !!map.getLayer('trace-issues-icons');
        const sync = (): void => {
            try {
                // Gate only the INITIAL layer installation. isStyleLoaded()
                // can briefly be false on an otherwise usable quiet map, so
                // existing layers must still receive fresh setData below. But
                // addSource/addLayer before the first style load always throws
                // and creates a noisy, avoidable first-paint failure. The
                // styledata listener and bounded retry below re-enter once the
                // initial style is ready.
                if (!layersUp() && !map.isStyleLoaded()) return;
                if (!map.getSource('trace-line')) {
                    map.addSource('trace-line', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                }
                for (const [id, width, blur, opacity] of [
                    ['trace-line-glow', 10, 8, 0.5],
                    ['trace-line-core', 3.5, 0, 0.95],
                ] as const) {
                    if (!map.getLayer(id)) {
                        map.addLayer({
                            id,
                            type: 'line',
                            source: 'trace-line',
                            layout: { 'line-join': 'round', 'line-cap': 'round' },
                            paint: {
                                'line-color': [
                                    'match',
                                    ['get', 'grade'],
                                    'clear',
                                    '#00e676',
                                    'caution',
                                    '#ffb300',
                                    'danger',
                                    '#ff1744',
                                    '#94a3b8', // pending — verdict still computing
                                ],
                                'line-width': width,
                                'line-blur': blur,
                                'line-opacity': opacity,
                            },
                        });
                    }
                }
                // Direction chevrons — "head south when you exit the bar, not
                // north" (Shane 2026-07-08). Auto-rotated along each leg; white
                // with a dark halo so they read over every grade colour.
                if (!map.getLayer('trace-line-arrows')) {
                    map.addLayer({
                        id: 'trace-line-arrows',
                        type: 'symbol',
                        source: 'trace-line',
                        layout: {
                            'symbol-placement': 'line',
                            'symbol-spacing': 90,
                            'text-field': '›',
                            'text-size': 18,
                            'text-keep-upright': false,
                            'text-allow-overlap': true,
                            'text-rotation-alignment': 'map',
                        },
                        paint: {
                            'text-color': '#ffffff',
                            'text-halo-color': '#0f172a',
                            'text-halo-width': 1.5,
                        },
                    });
                }
                // Proven-lane ghost (guided builder): dotted grey preview of a
                // curated fairway near the punter — accept it in the panel and
                // its points become pins.
                if (!map.getSource('trace-ghost')) {
                    map.addSource('trace-ghost', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                }
                if (!map.getLayer('trace-ghost-line')) {
                    map.addLayer({
                        id: 'trace-ghost-line',
                        type: 'line',
                        source: 'trace-ghost',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': '#94a3b8',
                            'line-width': 3,
                            'line-opacity': 0.7,
                            'line-dasharray': [1.5, 2],
                        },
                    });
                }
                // Problem spots ON the chart (P2): a ⚠ at every issue position —
                // the verdict computed the exact lat/lon all along; the panel row
                // alone left the punter guessing WHERE on a 2 NM leg the 2.1 m
                // patch was.
                if (!map.getSource('trace-issues')) {
                    map.addSource('trace-issues', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                }
                if (!map.getLayer('trace-issues-icons')) {
                    map.addLayer({
                        id: 'trace-issues-icons',
                        type: 'symbol',
                        source: 'trace-issues',
                        layout: { 'text-field': '⚠', 'text-size': 16, 'text-allow-overlap': true },
                        paint: {
                            'text-color': ['match', ['get', 'severity'], 'danger', '#ff1744', '#ffb300'],
                            'text-halo-color': '#0f172a',
                            'text-halo-width': 1.5,
                        },
                    });
                }
                const feats: Array<{
                    type: 'Feature';
                    properties: { grade: string };
                    geometry: { type: 'LineString'; coordinates: [number, number][] };
                }> = [];
                const issueFeats: Array<{
                    type: 'Feature';
                    properties: { severity: string };
                    geometry: { type: 'Point'; coordinates: [number, number] };
                }> = [];
                if (coordCaptureMode) {
                    for (let i = 1; i < capturedCoords.length; i++) {
                        const a = capturedCoords[i - 1];
                        const b = capturedCoords[i];
                        feats.push({
                            type: 'Feature',
                            properties: { grade: legVerdicts[i - 1]?.grade ?? 'pending' },
                            geometry: {
                                type: 'LineString',
                                coordinates: [
                                    [a.lon, a.lat],
                                    [b.lon, b.lat],
                                ],
                            },
                        });
                    }
                }
                // THE LINE GOES DOWN FIRST — before ANY verdict-shaped input is
                // touched. It used to be pushed after the issue loop below, and
                // the whole of sync() sits in one bare catch, so a single throw
                // in that loop left the layers up and the trace-line source
                // EMPTY. `layersUp()` was then true, which is precisely the
                // condition that switches the styledata heal and the retry
                // interval off — so it never recovered, for the life of that
                // mount. The pins are DOM markers on a separate effect and were
                // untouched, which is why it reads as "waypoints but no line"
                // rather than "the trace didn't load", and why 25b16f5d's
                // layer-readiness fix could not reach it: that commit made the
                // LAYERS exist, which is the very thing that disarms the retry.
                //
                // Ordering is the fix, not a try/catch: the line is the payload,
                // the ⚠ markers are decoration, and decoration must never be
                // able to take the payload down with it.
                (map.getSource('trace-line') as mapboxgl.GeoJSONSource).setData({
                    type: 'FeatureCollection',
                    features: feats as never,
                });
                if (coordCaptureMode) {
                    for (const v of legVerdicts) {
                        if (!v) continue; // pending slot — still grading
                        // `?? []` — a verdict rehydrated from an older persisted
                        // shape can reach here without `issues`.
                        for (const iss of v.issues ?? []) {
                            if (!iss.at) continue;
                            if (iss.severity === 'info') continue; // green confirmation → no ⚠ on the chart
                            issueFeats.push({
                                type: 'Feature',
                                properties: { severity: iss.severity },
                                geometry: { type: 'Point', coordinates: [iss.at.lon, iss.at.lat] },
                            });
                        }
                    }
                }
                (map.getSource('trace-issues') as mapboxgl.GeoJSONSource).setData({
                    type: 'FeatureCollection',
                    features: issueFeats as never,
                });
                (map.getSource('trace-ghost') as mapboxgl.GeoJSONSource).setData({
                    type: 'FeatureCollection',
                    features: (coordCaptureMode && capturedCoords.length <= 1
                        ? ghostLanes.map((l) => ({
                              type: 'Feature' as const,
                              properties: { id: l.id },
                              geometry: {
                                  type: 'LineString' as const,
                                  coordinates: l.points.map((p) => [p.lon, p.lat]),
                              },
                          }))
                        : []) as never,
                });
                // Course-frame bearing hint — thin dashed sky line from the
                // trace's live end (or the origin, pre-first-pin) to the 🏁
                // destination ghost. Pure orientation ("which way is
                // Mooloolaba"), never a route: it re-anchors as pins land.
                if (!map.getSource('trace-dest-hint')) {
                    map.addSource('trace-dest-hint', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                }
                if (!map.getLayer('trace-dest-hint-line')) {
                    map.addLayer({
                        id: 'trace-dest-hint-line',
                        type: 'line',
                        source: 'trace-dest-hint',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': '#38bdf8',
                            'line-width': 1.5,
                            'line-opacity': 0.45,
                            'line-dasharray': [1, 3],
                        },
                    });
                }
                const hintFrom = capturedCoords[capturedCoords.length - 1] ?? traceOrigin;
                (map.getSource('trace-dest-hint') as mapboxgl.GeoJSONSource).setData({
                    type: 'FeatureCollection',
                    features: (coordCaptureMode && traceDest && hintFrom
                        ? [
                              {
                                  type: 'Feature' as const,
                                  properties: {},
                                  geometry: {
                                      type: 'LineString' as const,
                                      coordinates: [
                                          [hintFrom.lon, hintFrom.lat],
                                          [traceDest.lon, traceDest.lat],
                                      ],
                                  },
                              },
                          ]
                        : []) as never,
                });
                // ── Lift the trace to the top, EVERY sync ──
                // The line was never buried by one specific layer; it was
                // buried by whatever happened to be added after it, because
                // NOTHING maintained its z-order. The one promoter that exists
                // (promoteNavLayers) is called only from the weather effect,
                // which early-returns on `activeLayers.size === 0` before it —
                // so with no weather layer up, which is now always the case on
                // the plan page, ordering was simply never enforced. The tracer
                // adds all six layers with no beforeId, so they sat wherever
                // the top of the style was at creation time and every ENC and
                // imagery layer added afterwards went over them. The pins are
                // DOM markers above the canvas, so they never showed the
                // problem — hence "waypoints but no line".
                //
                // Cheap and idempotent: six guarded moveLayer calls, run once
                // per pin edit, not on a timer.
                const buried = promoteTraceLayers(map);
                if (coordCaptureMode && feats.length > 0 && buried.length > 0) {
                    // Silent once the promotion works. If this ever fires, it
                    // names exactly what is still sitting on top — the evidence
                    // that was missing every previous time this was diagnosed.
                    log.warn(
                        `[trace] ${feats.length} leg(s) pushed but ${buried.length} layer(s) still above the line:`,
                        buried.slice(0, 8).join(', '),
                    );
                }
                // ENC cells and imagery mount ASYNCHRONOUSLY and land on top,
                // so promoting only during sync() leaves the line buried again
                // whenever a merge finishes after the last pin edit — the
                // "open a saved route and the line never appears" shape.
                // 'idle' is the natural "everything for this view has landed"
                // moment. One-shot and latched: the promote itself repaints,
                // which would re-fire idle, and re-arming there is how you get
                // the self-feeding loop this effect was already burned by
                // (2026-07-15). Only sync() ever re-arms it.
                if (!traceIdlePromoteRef.current) {
                    traceIdlePromoteRef.current = true;
                    map.once('idle', () => {
                        traceIdlePromoteRef.current = false;
                        try {
                            promoteTraceLayers(map);
                        } catch {
                            /* map mid-teardown */
                        }
                    });
                }
            } catch (e) {
                // Usually benign: addSource/addLayer throw while the style is
                // still doing its initial load, and the retry timer lands it.
                // LOGGED ANYWAY, because a throw here is also the failure mode
                // above, and a bare catch left no way to tell the two apart —
                // which is why "waypoints but no line" has been diagnosed from
                // first principles three times. warn(), not info(): createLogger
                // no-ops info in prod, so info would never reach the Xcode
                // console on a device build, which is the only place this bug
                // has ever been seen.
                log.warn('[trace] sync failed — line may be unpainted', e);
            }
        };
        sync();
        // Wake a parked render loop so the recolour paints NOW, not on
        // the next interaction (same rAF-stall as the stale-chart bug).
        try {
            map.triggerRepaint();
        } catch {
            /* map mid-teardown */
        }
        // HEAL, don't re-run: sync's own setData calls emit styledata, so
        // re-syncing on EVERY styledata was a self-feeding churn loop —
        // four setData pushes per event, payload growing with each leg
        // ("the more waypoints I add, the slower the page becomes",
        // 2026-07-15). The listener now only re-runs sync when a basemap
        // swap actually DROPPED the sources.
        // READINESS IS THE LAYERS, NOT THE SOURCE. This is the bug behind
        // "pull up an already made plan, it shows the waypoints but not the
        // line between them" (Shane 2026-07-22).
        //
        // sync() adds the source first and the layers second. addSource
        // succeeds even while the style is still initialising; addLayer THROWS,
        // and the try/catch above swallows it. Both guards below used to ask
        // `!map.getSource('trace-line')` — which by then was FALSE. So no retry
        // was armed, styledata never healed anything, and the trace data sat in
        // a source with no layer to draw it. Permanently, for that mount.
        //
        // The pins are DOM markers on a separate effect and so were untouched,
        // which is precisely why the symptom reads as "waypoints but no line"
        // instead of "the trace didn't load".
        //
        // Checking the layers keeps the anti-churn property the source check
        // was there for: once they exist, layersUp() is true and styledata
        // stops triggering work, so the ~8 Hz self-feeding loop of 2026-07-15
        // does not come back.
        const heal = (): void => {
            if (!layersUp()) sync();
        };
        map.on('styledata', heal);
        // First-paint retry: if the style wasn't ready at effect time, poll
        // briefly until the LAYERS land, then stop.
        const firstTry = !layersUp()
            ? window.setInterval(() => {
                  if (layersUp()) {
                      window.clearInterval(firstTry as number);
                      return;
                  }
                  sync();
              }, 300)
            : null;
        return () => {
            map.off('styledata', heal);
            if (firstTry !== null) window.clearInterval(firstTry);
        };
        // mapRef is named only to satisfy exhaustive-deps, which can no
        // longer see it is a stable ref object now that it arrives as a
        // parameter instead of a useRef in the same component. It never
        // changes identity, so this is runtime-inert — the effect still runs
        // exactly when the seven real deps change. This dep array carries no
        // suppression and must not gain one.
    }, [capturedCoords, legVerdicts, coordCaptureMode, ghostLanes, traceOrigin, traceDest, traceLayerNudge, mapRef]);
}
