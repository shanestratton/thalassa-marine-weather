/**
 * useTracerPinMarkers — the numbered, draggable, tappable pins.
 *
 * Extracted from MapHub verbatim. This is the most delicate unit in the tracer
 * because almost everything in it is read at FIRE time by a listener bound
 * once, not re-read on each render. The rules below are not style notes.
 *
 * `rec.index = i` MUST STAY ABOVE the `if (rec.sig === sig) return;`
 * early-continue. It is the only thing keeping the fire-time index reads
 * honest across inserts and deletes. Below the continue it stops running for
 * unchanged pins and every listener closure orphans onto a stale index.
 *
 * The three listeners — marker dragstart, marker dragend, and the element's
 * DOM click — are bound ONCE at record creation and never rebound. They
 * capture flashTraceFeedback, setSelectedPin, setInsertAfter and
 * insertAfterRef at that render, all of which are stable. Do not add an
 * .off()/removeEventListener that does not exist today.
 *
 * `e.stopPropagation()` in the click handler is load-bearing: it is the only
 * thing stopping the map's own click handler (which reads insertAfterRef at
 * tap time) from ALSO dropping a pin when the skipper taps an existing one.
 * Any change to marker DOM parentage, or a capture-phase map listener, breaks
 * tap-to-select.
 *
 * NEVER set `position` inline on the marker root. The comment inside is a
 * live-site autopsy: it overrides Mapbox's `.mapboxgl-marker { position:
 * absolute }`, drops the pin into document flow, and reads to the skipper as
 * "the route moves when you zoom". A CSS-modernising pass that adds
 * position:relative reintroduces it and nothing tests it.
 *
 * `locked` reads the legAnchor STATE, while other tracer code reads
 * legAnchorRef. Pass the state. The ref would make a chained start pin render
 * 🔒 while still draggable, or the reverse — and `locked` is baked into `sig`,
 * so the drag lock's correctness depends on it, since setDraggable only runs
 * below the sig continue.
 *
 * Deletions pop from the TAIL only. A middle insert or delete reuses existing
 * DOM elements and shifts data down the record array, so DOM stacking order
 * stays CREATION order and diverges from pin index order. That is intended.
 *
 * setCapturedCoords is the ONE capture that must be read at fire time, and it
 * goes through setCapturedCoordsRef for that reason. useTraceDraft mints a new
 * dispatcher per auth identity, and each one captures its own scope and
 * early-returns unless that scope is still current. A listener bound before a
 * sign-in or sign-out therefore held a dispatcher that had become a SILENT
 * no-op: Mapbox had already moved the marker, "Snapped onto the lead" flashed,
 * and the pin snapped back on the next render with no error anywhere.
 *
 * The latest-ref is correct rather than merely convenient. Marker records are
 * REUSED across identity changes — the effect repositions them from the new
 * draft instead of rebuilding them — so by the time a reused marker is
 * dragged, it represents the CURRENT draft's pin at that index, and the
 * current draft is exactly what the write must land on.
 *
 * This is the one deliberate render-time to fire-time conversion in this file.
 * Every other capture stays as it was: flashTraceFeedback, setSelectedPin and
 * setInsertAfter are genuinely stable, so routing them through refs would add
 * indirection and buy nothing.
 *
 * Also pre-existing and deliberately unfixed: the null-map early return fires
 * before the mode-off teardown and there is no re-entry ticket in the deps, so
 * a cold mount can render zero pins until a dep changes. And there is no
 * cleanup on the capture-mode-on path — teardown is only a later run seeing
 * mode false, plus tail pops. Do not add one.
 *
 * PAINT ORDER: must be called AFTER useTracerFrameMarkers. DOM markers carry
 * no z-index, so insertion order decides, and pins belong above the ghosts.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Dispatch, SetStateAction } from 'react';
import { triggerHaptic } from '../../utils/system';
import { snapTraceTapToLead, type TracerContext } from '../../services/routeTracer';

export interface TracerPinMarkerDeps {
    mapRef: React.RefObject<mapboxgl.Map | null>;
    /** Ref OBJECT — dragend reads .current at FIRE time to snap onto a lead. */
    tracerCtxRef: React.RefObject<TracerContext | null>;
    coordCaptureMode: boolean;
    capturedCoords: { lat: number; lon: number }[];
    /** Re-minted per auth identity, so listeners read it at fire time. */
    setCapturedCoords: Dispatch<SetStateAction<{ lat: number; lon: number }[]>>;
    selectedPin: number | null;
    setSelectedPin: Dispatch<SetStateAction<number | null>>;
    setInsertAfter: Dispatch<SetStateAction<number | null>>;
    insertAfterRef: { current: number | null };
    /** The STATE, never legAnchorRef. */
    legAnchor: { fromName: string } | null;
    flashTraceFeedback: (msg: string) => void;
}

export function useTracerPinMarkers({
    mapRef,
    tracerCtxRef,
    coordCaptureMode,
    capturedCoords,
    setCapturedCoords,
    selectedPin,
    setSelectedPin,
    setInsertAfter,
    insertAfterRef,
    legAnchor,
    flashTraceFeedback,
}: TracerPinMarkerDeps): void {
    // Always the CURRENT dispatcher. useTraceDraft re-mints setCapturedCoords
    // per auth identity and a superseded one silently early-returns, so a
    // listener bound before a sign-in would drop the drag on the floor.
    const setCapturedCoordsRef = useRef(setCapturedCoords);
    setCapturedCoordsRef.current = setCapturedCoords;
    // Per-pin marker records for RECONCILIATION (Shane 2026-07-15: "still
    // becoming unresponsive the moment I have a lot of waypoints"). The
    // old effect destroyed and recreated every DOM marker on EVERY pin
    // add / nudge / selection tap — O(N) DOM churn per interaction, and
    // the churn itself forced Mapbox to re-anchor all N roots. Records
    // let each pass touch only what changed: append = 1 create + 1
    // restyle, drag = 1 move, select = 2 restyles. `index` is LIVE —
    // listeners read it at fire time so inserts/deletes never orphan a
    // closure; `sig` is the rendered-style signature so unchanged pins
    // skip all style writes.
    const captureMarkersRef = useRef<
        Array<{
            marker: mapboxgl.Marker;
            el: HTMLDivElement;
            dot: HTMLDivElement;
            tag: HTMLDivElement | null;
            sig: string;
            lat: number;
            lon: number;
            index: number;
            dragged: boolean;
        }>
    >([]);
    // Drop / refresh a numbered pin per captured coord so the skipper can see
    // exactly where each tap landed. Pins are DRAGGABLE (nudge one and the
    // adjoining legs re-grade live) and TAPPABLE (select → Delete / Insert-
    // after in the panel). The visual circle stays 22 px but rides inside a
    // 40 px transparent hit-slop so gloved fingers can actually grab it.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const recs = captureMarkersRef.current;
        if (!coordCaptureMode) {
            recs.forEach((r) => r.marker.remove());
            captureMarkersRef.current = [];
            return;
        }
        // RECONCILE, don't rebuild: pins deleted → pop their markers;
        // everything else updates in place (position / style signature).
        while (recs.length > capturedCoords.length) recs.pop()!.marker.remove();
        capturedCoords.forEach((c, i) => {
            // Journey book-ends (Shane 2026-07-14): the FIRST pin IS the
            // green START button and the LAST pin IS the red finish ring —
            // middles stay numbered (2, 3, …). Appending a pin restyles
            // the old tail back to its number via the sig diff below.
            const isStart = i === 0;
            const isEnd = !isStart && i === capturedCoords.length - 1;
            // Chained-leg lock (Shane 2026-07-17): pin 1 of a "next leg" IS
            // the previous leg's arrival — exact coords, not draggable.
            const locked = isStart && legAnchor !== null;
            const label = isStart ? '1' : isEnd ? String(capturedCoords.length) : String(i + 1);
            const smallFont = capturedCoords.length > 9 && isEnd;
            const sig = `${isStart ? 's' : isEnd ? 'e' : 'm'}|${label}|${i === selectedPin ? 1 : 0}|${smallFont ? 1 : 0}|${locked ? 'L' : ''}`;
            let rec = recs[i];
            if (!rec) {
                const el = document.createElement('div');
                // NEVER set `position` inline on a Marker root: it overrides
                // Mapbox's .mapboxgl-marker { position: absolute } and drops
                // the pin into document FLOW — each pin then rendered a fixed
                // 40 px × index below its true anchor, which reads as "routes
                // move when you zoom" (Shane 2026-07-14; live-site autopsy:
                // transform said y=58, rect said y=118). The root is already
                // absolutely positioned by Mapbox, so it IS the containing
                // block for the absolute START label — no `relative` needed.
                el.style.cssText = 'width:40px;height:40px;display:flex;align-items:center;justify-content:center;';
                const dot = document.createElement('div');
                el.appendChild(dot);
                const marker = new mapboxgl.Marker({ element: el, draggable: true })
                    .setLngLat([c.lon, c.lat])
                    .addTo(map);
                const newRec: (typeof recs)[number] = {
                    marker,
                    el,
                    dot,
                    tag: null,
                    sig: '', // forces the first style pass below
                    lat: c.lat,
                    lon: c.lon,
                    index: i,
                    dragged: false,
                };
                marker.on('dragstart', () => {
                    newRec.dragged = true;
                });
                marker.on('dragend', () => {
                    const ll = marker.getLngLat();
                    triggerHaptic('light');
                    // Dragging NEAR a lead lands ON the lead (same fat-finger
                    // rule as placement; >120 m away stays where dropped).
                    let p0 = { lat: ll.lat, lon: ll.lng };
                    const ctx = tracerCtxRef.current;
                    const onLead = ctx ? snapTraceTapToLead(ctx, p0) : null;
                    if (onLead) {
                        p0 = onLead;
                        marker.setLngLat([p0.lon, p0.lat]);
                        flashTraceFeedback('Snapped onto the lead 🎯');
                    }
                    // p0 is a FRESH bare point — never spread the old one in.
                    // Dropping the `auto` tag is what promotes a dragged
                    // auto-inserted point to a hand-placed pin, so MapHub's
                    // auto-densify re-derives around the drag instead of
                    // stripping it on the next pass.
                    setCapturedCoordsRef.current((prev) => prev.map((p, j) => (j === newRec.index ? p0 : p)));
                });
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (newRec.dragged) {
                        newRec.dragged = false;
                        return;
                    }
                    triggerHaptic('light');
                    setSelectedPin((cur) => (cur === newRec.index ? null : newRec.index));
                    setInsertAfter(null);
                    insertAfterRef.current = null;
                });
                recs[i] = newRec;
                rec = newRec;
            }
            rec.index = i; // keep listener closures honest across inserts/deletes
            if (rec.lat !== c.lat || rec.lon !== c.lon) {
                rec.marker.setLngLat([c.lon, c.lat]);
                rec.lat = c.lat;
                rec.lon = c.lon;
            }
            if (rec.sig === sig) return; // style already right — zero writes
            rec.sig = sig;
            // Idempotent per style pass (the sig carries the lock flag).
            rec.marker.setDraggable(!locked);
            const ring =
                i === selectedPin
                    ? 'box-shadow:0 0 0 3px #38bdf8,0 1px 4px rgba(0,0,0,.5);'
                    : 'box-shadow:0 1px 4px rgba(0,0,0,.5);';
            if (isStart || isEnd) {
                const colour = isStart ? '#34d399' : '#f87171';
                // The sequence number rides INSIDE the ring (Shane
                // 2026-07-15: "1 inside the green, whatever the last
                // number is inside the red") — the journey book-ends
                // still count as waypoints.
                rec.dot.textContent = label;
                rec.dot.style.cssText = `width:22px;height:22px;border-radius:9999px;border:4px solid ${colour};background:rgba(15,23,42,0.85);color:${colour};display:flex;align-items:center;justify-content:center;font:800 ${smallFont ? 8 : 10}px sans-serif;${ring}`;
            } else {
                rec.dot.textContent = label;
                rec.dot.style.cssText = `background:#f59e0b;color:#000;border-radius:9999px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font:700 12px sans-serif;${ring}`;
            }
            if (isStart && !rec.tag) {
                // Label overflows the fixed 40 px hit-box (absolute, no
                // layout part) so the marker's centre anchor — and drag
                // grab point — stays exactly on the coordinate.
                const tag = document.createElement('div');
                tag.style.cssText =
                    'position:absolute;top:33px;left:50%;transform:translateX(-50%);font:800 9px/1 system-ui;letter-spacing:0.04em;color:#34d399;text-shadow:0 1px 3px #000;pointer-events:none;white-space:nowrap;';
                rec.el.appendChild(tag);
                rec.tag = tag;
            } else if (!isStart && rec.tag) {
                rec.tag.remove();
                rec.tag = null;
            }
            // Chained legs read "🔒 START" — the padlock says why this one
            // won't drag (its spot IS the previous leg's arrival).
            if (rec.tag) rec.tag.textContent = locked ? '🔒 START' : 'START';
        });
        // The five identities below are named only because exhaustive-deps
        // can no longer see they are stable once they arrive as parameters
        // rather than as useRef/useState results in the same component. All
        // five are stable for MapHub's lifetime, so this is runtime-inert.
    }, [
        capturedCoords,
        coordCaptureMode,
        selectedPin,
        legAnchor,
        flashTraceFeedback,
        setCapturedCoords,
        mapRef,
        tracerCtxRef,
        setSelectedPin,
        setInsertAfter,
        insertAfterRef,
    ]);
}
