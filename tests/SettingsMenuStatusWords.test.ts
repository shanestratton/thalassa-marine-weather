/**
 * Settings menu: status words short enough to stay on the title line
 * (build 126, 126-14; the follow-up recorded when 125-14 merged: "shorter
 * Settings status words so 'Not signed in' stays on the title line").
 *
 * Each row's state is { text, spoken, kind }:
 *  - `text` is what the row shows: "Sign in" (was "Not signed in" and "Needs
 *    sign-in"), "Off" (was "All alerts off");
 *  - `spoken` is what VoiceOver hears, unchanged ("Open Account & Cloud
 *    settings, Not signed in");
 *  - `kind` 'word' is a fixed vocabulary that sits whole on the title line or
 *    not at all; 'free' (a home port, a boat name) keeps 125-14's rule and
 *    drops under the title when it must.
 */
import { describe, expect, it } from 'vitest';
import { menuStatusFor, SETTINGS_STATE_WORDS, type SettingsMenuFacts } from '../components/settings/menuStatusWords';

const SIGNED_OUT: SettingsMenuFacts = { signedIn: false };
const SIGNED_IN: SettingsMenuFacts = { signedIn: true };

const alerts = (on: number, off = 2) => ({
    ...Object.fromEntries(Array.from({ length: on }, (_, i) => [`on${i}`, { enabled: true }])),
    ...Object.fromEntries(Array.from({ length: off }, (_, i) => [`off${i}`, { enabled: false }])),
});

describe('menuStatusFor: the short words', () => {
    it('signed out, both sign-in rows say "Sign in" and are heard as before', () => {
        expect(menuStatusFor('account', SIGNED_OUT)).toEqual({
            text: 'Sign in',
            spoken: 'Not signed in',
            kind: 'word',
        });
        expect(menuStatusFor('voyageLog', SIGNED_OUT)).toEqual({
            text: 'Sign in',
            spoken: 'Needs sign-in',
            kind: 'word',
        });
    });

    it('signed in: "Signed in", and the public page "Live" / "Off" once known, nothing while unknown', () => {
        expect(menuStatusFor('account', SIGNED_IN)).toEqual({ text: 'Signed in', spoken: 'Signed in', kind: 'word' });
        expect(menuStatusFor('voyageLog', { ...SIGNED_IN, voyageLogLive: true })).toEqual({
            text: 'Live',
            spoken: 'Live',
            kind: 'word',
        });
        expect(menuStatusFor('voyageLog', { ...SIGNED_IN, voyageLogLive: false })?.text).toBe('Off');
        expect(menuStatusFor('voyageLog', { ...SIGNED_IN, voyageLogLive: null })).toBeNull();
        expect(menuStatusFor('voyageLog', SIGNED_IN)).toBeNull();
    });

    it('no alert on reads "Off" (heard "All alerts off"); the counts are unchanged', () => {
        expect(menuStatusFor('alerts', { ...SIGNED_IN, notifications: alerts(0) })).toEqual({
            text: 'Off',
            spoken: 'All alerts off',
            kind: 'word',
        });
        expect(menuStatusFor('alerts', { ...SIGNED_IN, notifications: alerts(1) })).toEqual({
            text: '1 alert on',
            spoken: '1 alert on',
            kind: 'word',
        });
        expect(menuStatusFor('alerts', { ...SIGNED_IN, notifications: alerts(3) })?.text).toBe('3 alerts on');
        expect(menuStatusFor('alerts', SIGNED_IN)).toBeNull();
    });

    it('locations count as before', () => {
        expect(menuStatusFor('locations', SIGNED_IN)).toEqual({
            text: 'None saved',
            spoken: 'None saved',
            kind: 'word',
        });
        expect(menuStatusFor('locations', { ...SIGNED_IN, savedLocations: 4 })?.text).toBe('4 saved');
    });

    it('a home port and a boat name are free text, as 125-14 drew them', () => {
        expect(menuStatusFor('general', { ...SIGNED_IN, homePort: 'Las Palmas de Gran Canaria, Spain' })).toEqual({
            text: 'Home: Las Palmas de Gran Canaria',
            spoken: 'Home: Las Palmas de Gran Canaria',
            kind: 'free',
        });
        // A GPS fix keeps both halves; cutting at the comma left a bare latitude.
        expect(menuStatusFor('general', { ...SIGNED_IN, homePort: 'WP -33.0472, -71.6127' })?.text).toBe(
            'Home: WP -33.0472, -71.6127',
        );
        expect(menuStatusFor('general', { ...SIGNED_IN, homePort: 'Current Location' })?.text).toBe(
            'Home: your position',
        );
        expect(menuStatusFor('general', { ...SIGNED_IN, homePort: '  ' })).toBeNull();
        expect(menuStatusFor('vessel', { ...SIGNED_IN, vesselName: 'Albatross' })).toEqual({
            text: 'Albatross',
            spoken: 'Albatross',
            kind: 'free',
        });
        // Crew see the skipper's boat, not their own: no name on the row.
        expect(menuStatusFor('vessel', { ...SIGNED_IN, vesselName: 'Albatross', isObserver: true })).toBeNull();
        expect(menuStatusFor('somethingElse', SIGNED_IN)).toBeNull();
    });
});

describe('SETTINGS_STATE_WORDS: the vocabulary the fit spec sweeps', () => {
    it('holds every word a row can show, with its widest counts', () => {
        expect(SETTINGS_STATE_WORDS).toEqual({
            account: ['Signed in', 'Sign in'],
            voyageLog: ['Sign in', 'Live', 'Off'],
            alerts: ['Off', '1 alert on', '12 alerts on'],
            locations: ['None saved', '120 saved'],
        });
    });

    it('every word a row can show is in its vocabulary (a count as wide as its sample)', () => {
        const sweep: SettingsMenuFacts[] = [
            SIGNED_OUT,
            SIGNED_IN,
            { ...SIGNED_IN, voyageLogLive: true },
            { ...SIGNED_IN, voyageLogLive: false },
            ...[0, 1, 3, 9, 12].map((on) => ({ ...SIGNED_IN, notifications: alerts(on) })),
            ...[0, 1, 7, 42, 120].map((savedLocations) => ({ ...SIGNED_IN, savedLocations })),
        ];
        for (const facts of sweep) {
            for (const id of Object.keys(SETTINGS_STATE_WORDS) as (keyof typeof SETTINGS_STATE_WORDS)[]) {
                const state = menuStatusFor(id, facts);
                if (!state) continue;
                expect(state.kind, `${id} "${state.text}"`).toBe('word');
                const words: readonly string[] = SETTINGS_STATE_WORDS[id];
                const sample = state.text.replace(/^\d+/, (n) => (id !== 'alerts' ? '120' : n === '1' ? '1' : '12'));
                expect(words, `${id} "${state.text}"`).toContain(sample);
                expect(state.text.length, `${id} "${state.text}"`).toBeLessThanOrEqual(sample.length);
            }
        }
    });
});
