/**
 * The quiet-boat watch's status line (129-08), in boatLinkModel's words: what
 * the watch does, and that it hears her only while her Pi may use the
 * internet. Satellite mode keeps the Pi off the internet, so the line says
 * the watch will page that she has gone quiet. Zones worldwide. Until the
 * 129-08 watchdog answers, the line says what 125's does (the skipper alone,
 * no all-clear), and never promises guests a page.
 */
import { describe, expect, it } from 'vitest';
import { describeQuietWatch, quietWindowWords } from '../services/boatLink/boatLinkModel';

const auckland = { dow: 3, start: '19:30', end: '19:50', tz: 'Pacific/Auckland' };

describe('the quiet-boat status line', () => {
    it('the skipper: who is paged, the window in her own zone, and the internet caveat', () => {
        expect(
            describeQuietWatch({
                role: 'owner',
                watchOn: true,
                graceMin: 15,
                window: auckland,
                satellite: false,
                crewPaging: true,
            }),
        ).toBe(
            'After 15 min with nothing from her Pi, Thalassa pages you and the crew (not guests) you share the Instrument Panel with, and once more when she’s back. Up to 10 min of a dropout in her quiet window, Wed 19:30–19:50 Auckland time, doesn’t count. It hears her only while her Pi may use the internet.',
        );
    });

    it('the skipper while only 125’s watchdog answers: her alone, once, no all-clear, the whole window', () => {
        const line = describeQuietWatch({
            role: 'owner',
            watchOn: true,
            graceMin: 15,
            window: auckland,
            satellite: false,
            crewPaging: false,
        });
        expect(line).toBe(
            'After 15 min with nothing from her Pi, Thalassa pages you, once until she reports again. Silence in her quiet window, Wed 19:30–19:50 Auckland time, doesn’t count. It hears her only while her Pi may use the internet.',
        );
        expect(line).not.toMatch(/crew|when she’s back|Up to 10 min/);
    });

    it('no window: no window sentence', () => {
        const line = describeQuietWatch({
            role: 'owner',
            watchOn: false,
            graceMin: 15,
            window: null,
            satellite: false,
            crewPaging: true,
        });
        expect(line).not.toContain('quiet window');
        expect(line).toContain('It hears her only while her Pi may use the internet.');
    });

    it('satellite mode with the watch on: it cannot hear her, and will page', () => {
        expect(
            describeQuietWatch({
                role: 'owner',
                watchOn: true,
                graceMin: 15,
                window: auckland,
                satellite: true,
                crewPaging: true,
            }),
        ).toBe(
            'Satellite mode keeps her Pi off the internet, so Thalassa can’t hear her and will page that she has gone quiet. Switch this off first if you don’t want that.',
        );
    });

    it('crew: whether the skipper has it on, and whether they turned their own pages off', () => {
        const crew = { role: 'crew', graceMin: 15, window: null, satellite: false, crewPaging: true } as const;
        expect(describeQuietWatch({ ...crew, watchOn: true, pagingMe: true })).toBe(
            'Her skipper has the watch on: after 15 min with nothing from her Pi you’re paged, and told when she’s back. It hears her only while her Pi may use the internet.',
        );
        expect(describeQuietWatch({ ...crew, watchOn: true, pagingMe: false })).toBe(
            'Her skipper has the watch on, but you’ve turned these pages off for yourself.',
        );
        expect(describeQuietWatch({ ...crew, watchOn: false, pagingMe: true, satellite: true })).toBe(
            'Her skipper hasn’t switched the watch on, so nothing pages yet.',
        );
    });

    it('a window across midnight, in any zone, says its own days and zone', () => {
        expect(quietWindowWords({ dow: 6, start: '23:50', end: '00:10', tz: 'Europe/Paris' })).toBe(
            'Sat 23:50–00:10 Paris time',
        );
        expect(quietWindowWords({ dow: 0, start: '04:00', end: '04:20', tz: 'America/Argentina/Buenos_Aires' })).toBe(
            'Sun 04:00–04:20 Buenos Aires time',
        );
        expect(quietWindowWords({ dow: 1, start: '19:30:00', end: '19:50:00', tz: 'UTC' })).toBe('Mon 19:30–19:50 UTC');
    });
});
