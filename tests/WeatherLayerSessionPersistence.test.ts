/**
 * The chart's opening layer set — two of Shane's rules held at once
 * (2026-08-21): a COLD start always opens on the signature wind field, but
 * WITHIN a session the punter's own toggles (AIS on, wind off, whatever)
 * survive leaving the Obs tab and coming back. sessionStorage is the scope
 * that makes both true: it dies with the process, so no layer state ever
 * haunts a later boot.
 */
import { describe, expect, it } from 'vitest';
import { sessionInitialLayers, DEFAULT_LAYERS } from '../components/map/useWeatherLayers';

describe('sessionInitialLayers', () => {
    it('cold start (no session key) opens wind-only — even with a populated localStorage', () => {
        // localStorage is deliberately NOT consulted; only the session mirror.
        const layers = sessionInitialLayers(() => null);
        expect([...layers]).toEqual(DEFAULT_LAYERS);
    });

    it("a same-session remount restores the punter's selection", () => {
        const layers = sessionInitialLayers(() => JSON.stringify(['rain', 'pressure']));
        expect(layers.has('rain' as never)).toBe(true);
        expect(layers.has('pressure' as never)).toBe(true);
        expect(layers.has('wind' as never)).toBe(false);
    });

    it('an all-off selection is honoured, not bounced back to wind', () => {
        // "[]" is the punter saying everything off — restoring wind over the
        // top of that is exactly the old discard-their-choice bug.
        const layers = sessionInitialLayers(() => '[]');
        expect(layers.size).toBe(0);
    });

    it('unparseable session state falls back to the wind default', () => {
        const layers = sessionInitialLayers(() => '{not json');
        expect([...layers]).toEqual(DEFAULT_LAYERS);
    });

    it('a throwing storage read falls back to the wind default', () => {
        const layers = sessionInitialLayers(() => {
            throw new Error('storage unavailable');
        });
        expect([...layers]).toEqual(DEFAULT_LAYERS);
    });
});
