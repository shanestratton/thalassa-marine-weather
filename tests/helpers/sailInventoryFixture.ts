import type { SailInventory, SailWindSample } from '../../services/sailing/sailInventory';

/** Synthetic skipper input, not a rig default or a real vessel's sail limits. */
export const sailInventoryFixture = (): SailInventory => ({
    schema: 1,
    hysteresisKn: 2,
    sails: [
        { id: 'main', name: 'Fixture main', kind: 'main', reefPointsKn: [15, 25] },
        { id: 'headsail', name: 'Fixture jib', kind: 'headsail', reefPointsKn: [] },
    ],
    plans: [
        {
            id: 'light',
            name: 'Light plan',
            minTwsKn: 0,
            maxTwsKn: 15,
            minTwaDeg: 40,
            maxTwaDeg: 180,
            sails: [
                { sailId: 'main', reef: 0 },
                { sailId: 'headsail', reef: 0 },
            ],
        },
        {
            id: 'reef',
            name: 'Reduced plan',
            minTwsKn: 15,
            maxTwsKn: 35,
            minTwaDeg: 40,
            maxTwaDeg: 180,
            sails: [{ sailId: 'main', reef: 1 }],
        },
    ],
});
export const sailWindFixture = (wind = 12, offset = 0): SailWindSample => ({
    twsKn: wind,
    twaDeg: 90,
    timeMs: Date.parse('2026-10-17T12:00:00Z') + offset,
    sourceKey: 'fixture-model:2026-10-17T06Z',
});
