/**
 * The voyage track's source plan reads the boat link through its gate
 * (build 131, 131-01): a phone with no Pi and no gateway never loads it, and a
 * boat with one gets exactly the plan she got when it was a static import —
 * the same service's WHERE, LANE, KIND and DATA. Fictional data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    pairing: null as null | { deviceId: string },
    saved: null as null | { host: string; port: number },
    evaluate: vi.fn(),
}));

vi.mock('../services/PiPairingService', () => ({ getPairing: () => m.pairing }));
vi.mock('../services/NmeaListenerService', () => ({ NmeaListenerService: { getSavedConfig: () => m.saved } }));
vi.mock('../services/boatPositionChain', () => ({
    busFix: () => null,
    piFix: async () => null,
    cloudFix: async () => null,
}));
vi.mock('../services/piTrackRecorder', () => ({ getPiTrackStatus: async () => ({ enabled: false }) }));
vi.mock('../services/boatLink/BoatLinkService', () => ({ BoatLinkService: { evaluate: m.evaluate } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { resolveTrackSourcePlan } from '../services/shiplog/trackSourceInputs';
import { planTrackSource } from '../services/shiplog/trackSourcePlan';
import { loadedBoatLink, resetBoatLinkGateForTests } from '../services/boatLink/boatLinkGate';

const NOW = Date.parse('2026-10-15T01:00:00Z');

beforeEach(() => {
    resetBoatLinkGateForTests();
    m.pairing = null;
    m.saved = null;
    m.evaluate.mockReset();
    m.evaluate.mockReturnValue({ where: 'aboard', lane: 'socket', kind: 'boat-wifi', data: { state: 'live' } });
});

describe('the track source plan and the boat link (131-01)', () => {
    it('no Pi and no gateway: a phone plan, and the boat link is never loaded', async () => {
        const plan = await resolveTrackSourcePlan(NOW);
        expect(plan.source).toBe('phone');
        expect(plan.where).toBe('unknown');
        expect(m.evaluate).not.toHaveBeenCalled();
        expect(loadedBoatLink()).toBeNull();
    });

    it('a gateway saved: the boat link loads, and the plan is the one its facts always made', async () => {
        m.saved = { host: '192.0.2.151', port: 1457 };
        const plan = await resolveTrackSourcePlan(NOW);
        expect(m.evaluate).toHaveBeenCalledWith(NOW);
        expect(plan).toEqual(
            planTrackSource({
                boatConfigured: true,
                piRecorderOn: false,
                link: { where: 'aboard', lane: 'socket', kind: 'boat-wifi', data: 'live' },
                boatPosition: null,
                phoneAccessory: false,
            }),
        );
    });

    it('a boat link that cannot be read is "not known", never a throw', async () => {
        m.pairing = { deviceId: 'fixture-pi' };
        m.evaluate.mockImplementation(() => {
            throw new Error('store unavailable');
        });
        const plan = await resolveTrackSourcePlan(NOW);
        expect(plan.where).toBe('unknown');
    });
});
