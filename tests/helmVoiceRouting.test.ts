/**
 * The helm path must intercept the questions it owns, and nothing else.
 *
 * Two properties, and both are load-bearing:
 *
 *  1. A helm question NEVER reaches the network. That is the whole feature —
 *     in a squall thirty miles out there is no link to reach.
 *  2. Anything open-ended still gets to Calypso. A narrow grammar that
 *     quietly swallowed "should I reef" would be worse than no grammar.
 *
 * Also pinned: a store that throws degrades to "no reading", it does not take
 * the answer down. This runs while the skipper is steering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nmeaState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const anchorSnapshot = vi.hoisted(() => ({ current: null as unknown }));
const gpsFix = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => {
            if (nmeaState.current instanceof Error) throw nmeaState.current;
            return nmeaState.current;
        },
    },
}));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        getSnapshot: () => {
            if (anchorSnapshot.current instanceof Error) throw anchorSnapshot.current;
            return anchorSnapshot.current;
        },
    },
}));
vi.mock('../services/GpsService', () => ({
    GpsService: { getLastKnownPosition: () => gpsFix.current },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { units: { length: 'm' } } }) },
}));

import { gatherHelmSnapshot, tryHelmCommand } from '../services/voice/helmVoice';

const metric = (value: number | null, freshness = 'live') => ({ value, freshness });

describe('helm interception', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let spoken: string[];

    beforeEach(() => {
        vi.restoreAllMocks();
        spoken = [];
        nmeaState.current = {
            depth: metric(6.2),
            sog: metric(5.4),
            heading: metric(45),
            cog: metric(50),
            tws: metric(12.3),
            twd: metric(225),
            aws: metric(14.1),
            awa: metric(-40),
            waterTemp: metric(19.4),
        };
        anchorSnapshot.current = { state: 'idle', distanceFromAnchor: 0, swingRadius: 0, alarmCause: null };
        gpsFix.current = { latitude: -27.2058, longitude: 153.0899 };

        // Any network call at all is a failure of the premise.
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
            throw new Error('helm path must never touch the network');
        });
        vi.stubGlobal('speechSynthesis', {
            cancel: () => undefined,
            speak: (u: { text: string }) => spoken.push(u.text),
        });
        vi.stubGlobal(
            'SpeechSynthesisUtterance',
            class {
                text: string;
                rate = 1;
                constructor(text: string) {
                    this.text = text;
                }
            },
        );
    });

    it('answers depth from instruments, speaks it, and makes no network call', () => {
        const result = tryHelmCommand("what's the depth");
        expect(result).toEqual({ answer: '6.2 metres.', query: 'depth' });
        expect(spoken).toEqual(['6.2 metres.']);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('hands open-ended questions to Calypso instead of swallowing them', () => {
        for (const phrase of [
            'should I reef now',
            'is the depth safe here',
            'what will the wind do tomorrow',
            'play some music',
        ]) {
            expect(tryHelmCommand(phrase), phrase).toBeNull();
        }
        expect(spoken).toEqual([]);
    });

    it('cuts off the previous answer when a new question arrives', () => {
        const cancels: number[] = [];
        vi.stubGlobal('speechSynthesis', {
            cancel: () => cancels.push(1),
            speak: (u: { text: string }) => spoken.push(u.text),
        });
        tryHelmCommand('depth');
        tryHelmCommand('speed');
        expect(spoken).toEqual(['6.2 metres.', '5.4 knots.']);
        expect(cancels).toHaveLength(2);
    });

    it('can answer without speaking, for tests and for silent surfaces', () => {
        expect(tryHelmCommand('speed', { speak: false })?.answer).toBe('5.4 knots.');
        expect(spoken).toEqual([]);
    });
});

describe('a broken store degrades, it does not take the answer down', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        nmeaState.current = {};
        anchorSnapshot.current = { state: 'idle', distanceFromAnchor: 0, swingRadius: 0, alarmCause: null };
        gpsFix.current = null;
    });

    it('reports no reading when NMEA throws rather than propagating', () => {
        nmeaState.current = new Error('store exploded') as unknown as Record<string, unknown>;
        const snap = gatherHelmSnapshot();
        expect(snap.depth).toEqual({ value: null, freshness: 'dead' });
    });

    it('reports no anchor watch when the anchor service throws', () => {
        anchorSnapshot.current = new Error('anchor exploded');
        expect(gatherHelmSnapshot().anchor).toBeNull();
    });

    it('treats an absent barometer as no reading, not as zero pressure', () => {
        // helmVoice deliberately does not import the barometer module — asking
        // the depth must not start pressure logging as a side effect.
        const snap = gatherHelmSnapshot();
        expect(snap.pressureHpa).toBeNull();
        expect(snap.pressureTrend3h).toBeNull();
    });

    it('maps a missing metric to dead, so it is never spoken as live', () => {
        const snap = gatherHelmSnapshot();
        for (const key of ['depth', 'heading', 'cog', 'sog', 'tws', 'twd', 'aws', 'awa', 'waterTemp'] as const) {
            expect(snap[key], key).toEqual({ value: null, freshness: 'dead' });
        }
    });
});
