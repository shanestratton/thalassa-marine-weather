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
 * KNOWN AND DELIBERATELY NOT FIXED HERE: with no pins down, ghostKey is the
 * constant 'centre', so map.getCenter() is sampled once when the tracer opens.
 * Pan 50 km and the ghosts still sit near where you opened. Fixing that in a
 * move commit would make a behaviour change indistinguishable from a lift.
 */

import { useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { curatedLanesNear, type GhostLane } from '../../services/routeTracer';
import { communityLanesNear } from '../../services/communityRoutes';

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
        const centre =
            capturedCoords.length > 0
                ? capturedCoords[capturedCoords.length - 1]
                : map
                  ? { lat: map.getCenter().lat, lon: map.getCenter().lng }
                  : null;
        if (!centre) {
            setGhostLanes((prev) => (prev.length === 0 ? prev : []));
            return;
        }
        const bbox: [number, number, number, number] = [
            centre.lon - 0.05,
            centre.lat - 0.05,
            centre.lon + 0.05,
            centre.lat + 0.05,
        ];
        // Curated lanes land instantly; approved community lanes merge in as
        // the RPC returns (10-min cached). Stale-guarded — a pin drop mid-
        // fetch supersedes this run.
        let stale = false;
        setGhostLanes(curatedLanesNear(bbox));
        void communityLanesNear(bbox).then((community) => {
            if (stale || community.length === 0) return;
            setGhostLanes((prev) => {
                const seen = new Set(prev.map((l) => l.id));
                return [...prev, ...community.filter((l) => !seen.has(l.id))];
            });
        });
        return () => {
            stale = true;
        };
        // capturedCoords is read for the centre only — ghostKey already
        // encodes it to ~100 m, so re-running on every array identity
        // would defeat the whole gate.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ghostKey]);

    return ghostLanes;
}
