/**
 * useTracerGhostLanes — the dotted grey "proven lane" ghosts drawn near the
 * start of a trace, so "trace out of the marina" is two taps wherever a
 * curated or community lane already exists.
 *
 * Extracted from MapHub verbatim. Fully self-contained: one piece of state,
 * one derived key, one effect, and nothing outside ever calls the setter.
 *
 * ghostKey IS THE PERF GATE and must stay exactly as it is — computed at
 * render, unmemoised, inside this hook. Ghosts only ever render while the
 * trace has one pin or none, yet this effect used to rescan and mint a fresh
 * array on EVERY pin edit, dirtying the trace-line sync's deps for a wasted
 * 4x setData pass per pin (perf hunt 2026-07-15). The primitive key kills
 * that. Do NOT wrap it in useMemo: a useMemo needs a dep array that would
 * have to name capturedCoords, which is the precise re-run this gate exists
 * to prevent. The toFixed(3) (~100 m) is calibrated — changing the digit
 * count changes how often both this effect AND the 385-line trace-layer
 * effect re-run.
 *
 * THE THREE SETTER STYLES ARE DELIBERATE, not inconsistency to tidy up:
 *   - the two "clear" paths are identity-preserving (prev.length === 0 ? prev
 *     : []), because a naive setGhostLanes([]) mints a new array and dirties
 *     the trace-layer effect's deps for nothing;
 *   - the curated write is a wholesale non-functional replace;
 *   - the community write is a functional merge that de-dupes by id.
 * Converting the third to functional changes which lanes win that de-dupe.
 *
 * Curated lanes land synchronously; community lanes merge in as the RPC
 * returns (10-min cached). Awaiting both would change first paint of the
 * overlay. `stale` stays a per-run closure let, set in the cleanup — promoting
 * it to a ref would convert a render-time capture into a fire-time read.
 *
 * WITH NO PINS DOWN the key is the constant 'centre', so nothing in the dep
 * array can notice a pan — the ghosts used to stay wherever the tracer
 * happened to open, however far you sailed the map afterwards. A moveend
 * listener re-scans instead, and only once the centre has left the box we
 * last scanned. The gate still holds: small pans cost nothing, and with a pin
 * down the listener is never attached, because the key already tracks the pin.
 * A re-scan that finds the same lanes keeps the previous array identity, so it
 * cannot dirty the trace-layer sync's deps for nothing.
 */

import { useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { curatedLanesNear, type GhostLane } from '../../services/routeTracer';
import { communityLanesNear } from '../../services/communityRoutes';

/** Half-width of the scanned box, in degrees (~5.5 km). Doubles as the
 *  re-scan threshold: we rescan once the map centre has left the box. */
const GHOST_BOX_DEG = 0.05;

/** Keep the PREVIOUS array when a re-scan found the same lanes. A fresh array
 *  with identical contents is a new identity, and ghostLanes is a dep of the
 *  385-line trace-layer sync — handing it one would cost a full setData pass
 *  for nothing, which is the exact waste this whole gate exists to prevent. */
function keepIfSameLanes(prev: GhostLane[], next: GhostLane[]): GhostLane[] {
    if (prev.length !== next.length) return next;
    const seen = new Set(prev.map((l) => l.id));
    return next.every((l) => seen.has(l.id)) ? prev : next;
}

export function useTracerGhostLanes(
    /** The ref OBJECT — the effect reads .current at effect-run time and calls
     *  map.getCenter() there. Passing a value makes it a render-time read. */
    mapRef: React.RefObject<mapboxgl.Map | null>,
    coordCaptureMode: boolean,
    capturedCoords: { lat: number; lon: number }[],
): GhostLane[] {
    /** Proven-lane ghosts: curated fairways near the trace area, drawn dotted
     *  grey; accepting one loads its pins ("trace out of the marina" solved
     *  in two taps where a lane exists). */
    const [ghostLanes, setGhostLanes] = useState<GhostLane[]>([]);
    // Ghosts only ever RENDER while the trace has ≤1 pin (the "trace out
    // of the marina" moment) — yet this effect used to rescan lanes and
    // mint a fresh array on EVERY pin edit, dirtying the trace-line
    // sync's deps for a wasted 4×setData pass per pin (perf hunt
    // 2026-07-15). The primitive key kills that: 'off' once ≥2 pins
    // exist, else the first pin rounded to ~100 m — nudges and pans
    // don't rescan, a genuinely new start area does.
    const ghostKey =
        !coordCaptureMode || capturedCoords.length > 1
            ? 'off'
            : capturedCoords.length === 1
              ? `${capturedCoords[0].lat.toFixed(3)},${capturedCoords[0].lon.toFixed(3)}`
              : 'centre';
    useEffect(() => {
        if (ghostKey === 'off') {
            setGhostLanes((prev) => (prev.length === 0 ? prev : []));
            return;
        }
        const map = mapRef.current;
        const pinned = capturedCoords.length > 0 ? capturedCoords[capturedCoords.length - 1] : null;
        const mapCentre = (): { lat: number; lon: number } | null =>
            map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : null;
        const centre = pinned ?? mapCentre();
        if (!centre) {
            setGhostLanes((prev) => (prev.length === 0 ? prev : []));
            return;
        }
        // Curated lanes land instantly; approved community lanes merge in as
        // the RPC returns (10-min cached). Stale-guarded — a pin drop mid-
        // fetch supersedes this run, and so does a later re-scan.
        let stale = false;
        let scanId = 0;
        let scannedAt = centre;
        const scan = (at: { lat: number; lon: number }): void => {
            const mine = ++scanId;
            scannedAt = at;
            const bbox: [number, number, number, number] = [
                at.lon - GHOST_BOX_DEG,
                at.lat - GHOST_BOX_DEG,
                at.lon + GHOST_BOX_DEG,
                at.lat + GHOST_BOX_DEG,
            ];
            setGhostLanes((prev) => keepIfSameLanes(prev, curatedLanesNear(bbox)));
            void communityLanesNear(bbox).then((community) => {
                if (stale || mine !== scanId || community.length === 0) return;
                setGhostLanes((prev) => {
                    const seen = new Set(prev.map((l) => l.id));
                    return [...prev, ...community.filter((l) => !seen.has(l.id))];
                });
            });
        };
        scan(centre);
        // With NO pins down the key is the constant 'centre', so nothing in
        // the dep array can notice a pan — the ghosts used to stay wherever
        // the tracer happened to open, however far you sailed the map after.
        // Re-scan on moveend instead, and only once the centre has left the
        // box we scanned, so the gate still holds: a nudge or a small pan
        // costs nothing, and with a pin down this listener never exists.
        if (pinned || !map)
            return () => {
                stale = true;
            };
        const onMoveEnd = (): void => {
            const now = mapCentre();
            if (!now) return;
            if (
                Math.abs(now.lat - scannedAt.lat) <= GHOST_BOX_DEG &&
                Math.abs(now.lon - scannedAt.lon) <= GHOST_BOX_DEG
            )
                return;
            scan(now);
        };
        map.on('moveend', onMoveEnd);
        return () => {
            stale = true;
            map.off('moveend', onMoveEnd);
        };
        // capturedCoords is read for the centre only — ghostKey already
        // encodes it to ~100 m, so re-running on every array identity
        // would defeat the whole gate.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ghostKey]);

    return ghostLanes;
}
