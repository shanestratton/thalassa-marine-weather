/**
 * What Calypso says at the helm, and — more importantly — what he refuses to
 * say.
 *
 * The load-bearing rule is that a dead instrument must never be read aloud as
 * a live one. A depth sounder that stopped a minute ago still holds "6.2", and
 * a confident voice saying "six point two metres" while the boat is in two is
 * the worst thing this feature could do, because the skipper has no way to
 * tell it happened.
 */
import { describe, expect, it } from 'vitest';
import { answerHelmQuery, spokenBearing, spokenLatLon, type HelmSnapshot } from '../services/voice/helmAnswers';

const live = (value: number | null) => ({ value, freshness: 'live' as const });
const stale = (value: number | null) => ({ value, freshness: 'stale' as const });
const dead = (value: number | null) => ({ value, freshness: 'dead' as const });
const none = () => ({ value: null, freshness: 'dead' as const });

const snapshot = (over: Partial<HelmSnapshot> = {}): HelmSnapshot => ({
    depth: live(6.2),
    depthUnit: 'm',
    heading: live(45),
    cog: live(50),
    sog: live(5.4),
    tws: live(12.3),
    twd: live(225),
    aws: live(14.1),
    awa: live(-40),
    waterTemp: live(19.4),
    pressureHpa: 1020.4,
    pressureTrend3h: 0.2,
    position: { latitude: -27.2058, longitude: 153.0899 },
    anchor: null,
    now: new Date('2026-08-09T08:05:00'),
    ...over,
});

describe('never speak a stale number as current', () => {
    it('refuses a dead instrument outright, and names which one', () => {
        const said = answerHelmQuery('depth', snapshot({ depth: dead(6.2) }));
        expect(said).toBe('No depth — instrument not reporting.');
        // The last value must not appear anywhere in the utterance.
        expect(said).not.toMatch(/6|six/);
    });

    it('speaks a stale reading but always labels it', () => {
        // One full stop, at the end — not one mid-answer where a synthesiser
        // would pause as though it had finished.
        expect(answerHelmQuery('depth', snapshot({ depth: stale(6.2) }))).toBe('6.2 metres — stale.');
    });

    it('names the missing instrument rather than saying "no data"', () => {
        expect(answerHelmQuery('speed', snapshot({ sog: none() }))).toContain('speed');
        expect(answerHelmQuery('water-temp', snapshot({ waterTemp: none() }))).toContain('water temperature');
    });
});

describe('readings', () => {
    it('is terse — the whole answer is the number and its unit', () => {
        expect(answerHelmQuery('depth', snapshot())).toBe('6.2 metres.');
        expect(answerHelmQuery('speed', snapshot())).toBe('5.4 knots.');
    });

    it('honours the skipper’s depth unit', () => {
        expect(answerHelmQuery('depth', snapshot({ depthUnit: 'ft' }))).toBe('20.3 feet.');
    });

    it('drops a trailing .0 so the synthesiser does not say "point zero"', () => {
        expect(answerHelmQuery('speed', snapshot({ sog: live(6) }))).toBe('6 knots.');
    });

    it('says bearings as digits, the way they are heard at sea', () => {
        expect(spokenBearing(45)).toBe('zero four five');
        expect(spokenBearing(0)).toBe('zero zero zero');
        expect(spokenBearing(359.6)).toBe('zero zero zero');
        expect(spokenBearing(180)).toBe('one eight zero');
        expect(answerHelmQuery('heading', snapshot())).toBe('Heading zero four five.');
    });

    it('refuses to read a course over ground when not making way', () => {
        // COG at rest is the direction of a movement that isn't happening. It
        // wanders freely, and reading it out is worse than saying nothing.
        const said = answerHelmQuery('course', snapshot({ sog: live(0.1) }));
        expect(said).toBe('Not making way — no course over ground.');
        expect(said).not.toMatch(/five zero|zero five zero/);
    });

    it('reads a real course when the boat is moving', () => {
        expect(answerHelmQuery('course', snapshot())).toBe('Course zero five zero.');
    });
});

describe('wind', () => {
    it('prefers true wind and says where it is from', () => {
        expect(answerHelmQuery('wind', snapshot())).toBe('True wind 12.3 knots from two two five.');
    });

    it('falls back to apparent, labelled, with the side it is on', () => {
        const said = answerHelmQuery('wind', snapshot({ tws: none(), twd: none() }));
        expect(said).toBe('Apparent wind 14.1 knots at 40 degrees port.');
    });

    it('calls starboard starboard', () => {
        const said = answerHelmQuery('wind', snapshot({ tws: none(), twd: none(), awa: live(40) }));
        expect(said).toContain('starboard');
    });

    it('says nothing rather than guessing when neither is reporting', () => {
        expect(answerHelmQuery('wind', snapshot({ tws: none(), aws: none() }))).toBe(
            'No wind — instrument not reporting.',
        );
    });
});

describe('position', () => {
    it('reads degrees and minutes with hemispheres', () => {
        expect(spokenLatLon(-27.2058, 153.0899)).toBe('27 degrees 12.3 minutes south, 153 degrees 5.4 minutes east');
    });

    it('says the GPS has no fix rather than reading a stale one', () => {
        expect(answerHelmQuery('position', snapshot({ position: null }))).toBe('No position — GPS has no fix.');
    });
});

describe('pressure', () => {
    it('calls a sub-half-hectopascal drift steady rather than inventing weather', () => {
        expect(answerHelmQuery('pressure', snapshot({ pressureTrend3h: 0.2 }))).toBe('1020 hectopascals, steady.');
        expect(answerHelmQuery('pressure', snapshot({ pressureTrend3h: -0.4 }))).toContain('steady');
    });

    it('reports a real trend with its direction and size', () => {
        expect(answerHelmQuery('pressure', snapshot({ pressureTrend3h: -2.6 }))).toBe(
            '1020 hectopascals, falling 2.6 in three hours.',
        );
    });

    it('omits the trend entirely when there is not enough history to have one', () => {
        expect(answerHelmQuery('pressure', snapshot({ pressureTrend3h: null }))).toBe('1020 hectopascals.');
    });
});

describe('anchor', () => {
    it('leads with the alarm when dragging — nothing else matters', () => {
        const said = answerHelmQuery(
            'anchor',
            snapshot({ anchor: { armed: true, distanceM: 71, radiusM: 40, dragging: true } }),
        );
        expect(said).toBe('Dragging. Anchor alarm is sounding.');
    });

    it('gives distance against the set radius when holding', () => {
        expect(
            answerHelmQuery(
                'anchor',
                snapshot({ anchor: { armed: true, distanceM: 22.4, radiusM: 40, dragging: false } }),
            ),
        ).toBe('Holding. 22 metres out of 40.');
    });

    it('says the watch is off rather than implying it is on', () => {
        expect(answerHelmQuery('anchor', snapshot({ anchor: null }))).toBe('Anchor watch is off.');
        expect(
            answerHelmQuery(
                'anchor',
                snapshot({ anchor: { armed: false, distanceM: 5, radiusM: 40, dragging: false } }),
            ),
        ).toBe('Anchor watch is off.');
    });
});

describe('time', () => {
    it('reads the clock as four digits', () => {
        expect(answerHelmQuery('time', snapshot())).toBe('08 05.');
    });
});
