/**
 * One wind activation must cost ONE fetch.
 *
 * Wind gained its own z9 framing flyTo (700 ms). The data effect fired its
 * fetch 200 ms after activation, i.e. mid-flight, against a camera the app was
 * actively leaving — and the landing then tripped boundsChangedSignificantly
 * (zoom moved by more than 1) into a FULL refetch rather than the "at most a
 * top-up" the 200 ms delay was justified on. Shane's device log, 2026-08-22:
 *
 *     wind fetch ecmwf 4×8×48h  1528ms   <- thrown away
 *     wind fetch ecmwf 9×16×48h 1680ms   <- the one that paints
 *
 * 3.2 s of fetching for one activation, half of it for a viewport never shown
 * — and against an Open-Meteo floor of ~1.2 s per call that we do not own,
 * a wasted call is the most expensive mistake available here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
const effect = src.slice(
    src.indexOf('// 200 ms, was 800:'),
    src.indexOf('}, [activeKey, mapReady, windState.model, windState.field]);'),
);

describe('wind fetch waits for the framing camera', () => {
    it('defers activate() while the camera is still animating', () => {
        expect(effect).toContain('m.isMoving() || m.isZooming() || m.isEasing()');
        expect(effect).toContain("m.on('moveend', onSettled)");
    });

    it('still fetches immediately when the camera is already settled', () => {
        // The common warm case — wind already at z9 — must not pay a wait.
        const idlePath = effect.slice(effect.indexOf('if (!(m.isMoving()'), effect.indexOf('let fired = false'));
        expect(idlePath).toContain('run();');
        expect(idlePath).toContain('return;');
    });

    it('never waits forever on a moveend that is not coming', () => {
        // A flyTo interrupted by a gesture can end without the moveend we are
        // listening for. Wind must degrade to fetching late, never to never.
        expect(effect).toContain('settleGuard = setTimeout(onSettled, 1_200)');
    });

    it('tears down its listener and timers when the layer flips off mid-wait', () => {
        // Otherwise a toggle during the flyTo leaves a listener that fires an
        // activate() for a layer the user has already turned off.
        expect(effect).toContain('cancelled = true');
        expect(effect).toContain('detachMoveEnd?.()');
        expect(effect).toContain('if (settleGuard) clearTimeout(settleGuard)');
        expect(effect).toContain('if (cancelled) return;');
    });
});
