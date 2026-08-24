/**
 * Where the storm view opens, and how you get out of it.
 *
 * Both reported by Shane on 2026-08-23: "can we start the storm layer at zoom
 * 2.1?" and "i can not exit from the storm layer".
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CYCLONE_OPEN_ZOOM } from '../components/map/useCycloneLayer';
import { buildTacticalState } from '../components/map/buildTacticalState';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

const src = readFileSync('components/map/useCycloneLayer.ts', 'utf8');

describe('storm view opening zoom', () => {
    it('is the frame Shane asked for by name', () => {
        // 2, was 2.1 (2026-08-24, the skipper's final answer): the widest
        // whole-world open, every basin visible, the stepper for the rest.
        expect(CYCLONE_OPEN_ZOOM).toBe(2);
    });

    it('is used by every opening flight, not hard-coded three times', () => {
        // It was `zoom: 1` in three separate places, so "change the opening
        // zoom" meant finding all three. One constant, one decision.
        const effect = src.slice(src.indexOf('// ── Synoptic view'), src.indexOf('const onMoveEnd'));
        expect(effect).toContain('zoom: CYCLONE_OPEN_ZOOM, duration: 800');
        expect(effect).toContain('zoom: CYCLONE_OPEN_ZOOM, duration: 400');
        // …and the focus flight that lands on the storm itself.
        const focus = src.slice(src.indexOf('Flying to ${focusTarget.name}'), src.indexOf('} catch (e) {'));
        expect(focus).toContain('zoom: CYCLONE_OPEN_ZOOM');
        // No stragglers anywhere in the camera work.
        expect(src.slice(src.indexOf('// ── Synoptic view'))).not.toContain('zoom: 1,');
    });

    it('changes where the view lands, NOT how far out you may pull', () => {
        // minZoom stays 1. The ask was about the opening frame.
        expect(src).toContain('map.setMinZoom(1);');
    });

    it('never reads a mid-flight zoom when a storm is picked', () => {
        // The card effect recentres on the picked storm and otherwise keeps
        // the user's zoom — but on a first open it fires while the opening
        // flight is still in the air, and map.getZoom() is then a transient
        // somewhere between the chart's boot zoom and the target. Clamping
        // that to CYCLONE_MAX_ZOOM parked the view at z8, so "opens at 2.1"
        // would have held only when no storm was selected.
        const card = src.slice(src.indexOf('const settledZoom'), src.indexOf('duration: 1200 }'));
        expect(card).toContain('map.isMoving()');
        expect(card).toContain('openZoomRef.current');
        expect(card).toContain('Math.min(map.getZoom(), CYCLONE_MAX_ZOOM)');
    });
});

describe('leaving the storm view', () => {
    const storm = (sid: string) => ({ sid, name: sid, basin: 'W' }) as unknown as ActiveCyclone;

    const deps = (cycloneVisible: boolean, cyclones: ActiveCyclone[]) => {
        const setCycloneVisible = vi.fn();
        const setStormPickerOpen = vi.fn();
        const noop = vi.fn();
        const state = buildTacticalState({
            aisVisible: false,
            setAisVisible: noop,
            cycloneVisible,
            setCycloneVisible,
            squallVisible: false,
            setSquallVisible: noop,
            allCyclones: cyclones,
            cyclonePickerPendingRef: { current: false },
            setStormPickerOpen,
            setChokepointVisible: noop,
            seamarkVisible: false,
            setSeamarkVisible: noop,
            tideStationsVisible: false,
            setTideStationsVisible: noop,
            anchorageVisible: false,
            setAnchorageVisible: noop,
            lightningVisible: false,
            setLightningVisible: noop,
            weatherInspectMode: false,
            setWeatherInspectMode: noop,
            weather: { setActiveLayer: noop, activeLayers: new Set() },
        } as never);
        const toggle = state.onToggleCyclones;
        // Typed optional on the tactical-state surface; a missing handler is
        // itself the bug this file guards, so fail loudly rather than skip.
        if (typeof toggle !== 'function') throw new Error('onToggleCyclones is not wired');
        return { toggle, setCycloneVisible, setStormPickerOpen };
    };

    it('turns OFF when it is on, however many storms are live', () => {
        // THE BUG: the multi-storm branch opened the picker and returned, so
        // this control could only ever turn the layer on. Tapping "Storms"
        // again re-opened the picker — no way back out. Shane had three
        // storms up, which is exactly when it bites.
        for (const cyclones of [[], [storm('a')], [storm('a'), storm('b'), storm('c')]]) {
            const { toggle, setCycloneVisible, setStormPickerOpen } = deps(true, cyclones);
            toggle();
            expect(setCycloneVisible).toHaveBeenCalledWith(false);
            expect(setStormPickerOpen).not.toHaveBeenCalled();
        }
    });

    it('still opens the picker on the way IN with more than one storm', () => {
        // The reason that branch exists is a good one — it names every storm
        // at once. It just must not be the only outcome.
        const { toggle, setCycloneVisible, setStormPickerOpen } = deps(false, [storm('a'), storm('b')]);
        toggle();
        expect(setStormPickerOpen).toHaveBeenCalledWith(true);
        expect(setCycloneVisible).toHaveBeenCalledWith(true);
    });

    it('plain-toggles on with one storm or none', () => {
        const { toggle, setCycloneVisible, setStormPickerOpen } = deps(false, [storm('a')]);
        toggle();
        expect(setCycloneVisible).toHaveBeenCalledWith(true);
        expect(setStormPickerOpen).not.toHaveBeenCalled();
    });
});
