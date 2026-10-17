import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { OwnBoatSkillKeeper, type OwnSkillDeps, type OwnSkillContext } from './ownBoatSkill/keeper.js';
import type { SkillControl } from './ownBoatSkill/store.js';
import { OWN_BOAT_SKILL as LIMIT, type OwnBoatCapability } from './ownBoatSkillWire.js';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    VESSEL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    PHONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
function fixture() {
    let now = Date.UTC(2026, 9, 16, 12, 30),
        mono = 1000;
    let control: SkillControl = { schema: 1, generation: 'absent', highWater: 0, blockedRevision: null, active: null };
    const identity = {
        ownerId: OWNER,
        piDeviceId: PI,
        controllerId: PHONE,
        pairingRevision: 'a'.repeat(64),
        enrollmentRevision: 'b'.repeat(64),
    };
    let source: OwnSkillContext['source'] = {
        selfKey: 'c'.repeat(64),
        windSourceKey: 'd'.repeat(64),
        positionSourceKey: 'e'.repeat(64),
        windSource: 'synthetic.WI',
        positionSource: 'synthetic.GP',
        sample: {
            at: now - 1000,
            receivedAt: now,
            positionAt: now - 1000,
            cell: '-2725_15300',
            windMps: 10,
            rawWind: '{}',
        },
    };
    const mutations = { off: 0, samples: 0, captures: 0, forecastReads: 0, verifications: 0, contexts: 0 };
    let allowInternet = true,
        hour = -1;
    const deps: OwnSkillDeps = {
        enabled: true,
        now: () => now,
        monotonic: () => mono,
        store: {
            control: () => structuredClone(control),
            install: (active, at, expected) => {
                assert.equal(control.generation, expected);
                control = {
                    schema: 1,
                    generation: randomUUID(),
                    highWater: at,
                    active,
                    blockedRevision: control.active?.consent.revision ?? control.blockedRevision,
                };
                return structuredClone(control);
            },
            off: (at) => {
                mutations.off++;
                control = {
                    ...control,
                    generation: randomUUID(),
                    highWater: Math.max(at, control.highWater),
                    blockedRevision: control.active?.consent.revision ?? control.blockedRevision,
                    active: null,
                };
                return structuredClone(control);
            },
            touch: (generation, at) => {
                assert.equal(control.generation, generation);
                control.highWater = Math.max(at, control.highWater);
            },
            enable: (generation, at) => {
                assert.equal(control.generation, generation);
                assert(control.active);
                control.active.logging = true;
                control.highWater = Math.max(at, control.highWater);
            },
            sample: () => {
                mutations.samples++;
                return true;
            },
            capture: () => {
                mutations.captures++;
                return true;
            },
            evidence: () => ({ samples: [], issues: [] }),
            claimCaptureHour: () => {
                const h = Math.floor(now / 3600_000);
                if (h === hour) return false;
                hour = h;
                return true;
            },
        },
        owner: {
            verify: async (_token, ownerId, vesselId, current) => {
                mutations.verifications++;
                assert(current());
                return { ownerId, vesselId, vesselRevision: 4, vesselName: 'Synthetic vessel', verifiedAt: now };
            },
        },
        context: async (id) => {
            mutations.contexts++;
            return id === PHONE ? { identity: { ...identity }, source, allowInternet, current: () => true } : null;
        },
        forecasts: {
            read: async () => {
                mutations.forecastReads++;
                return null;
            },
        },
    };
    const keeper = new OwnBoatSkillKeeper(deps);
    const grant = async (logging = true): Promise<OwnBoatCapability> => {
        const p = await keeper.prepare({ schema: 1, vesselId: VESSEL }, PHONE, 'synthetic');
        const result = await keeper.confirm({ schema: 1, nonce: p.nonce, logging }, PHONE, 'synthetic');
        if (logging) await keeper.enable(result.capability, PHONE);
        return result;
    };
    return {
        keeper,
        deps,
        grant,
        mutations,
        identity,
        get control() {
            return control;
        },
        setSource: (value: typeof source) => {
            source = value;
        },
        get source() {
            return source;
        },
        setInternet: (value: boolean) => {
            allowInternet = value;
        },
        advance: (wall: number, monotonic = wall) => {
            now += wall;
            mono += monotonic;
        },
    };
}
test('logger is default OFF and a read-only explicit review never starts acquisition', async () => {
    const f = fixture();
    await f.keeper.tick();
    assert.equal(f.mutations.contexts, 0);
    const g = await f.grant(false);
    assert.equal(f.mutations.verifications, 2);
    await f.keeper.tick();
    assert.equal(f.mutations.samples, 0);
    assert.equal(f.mutations.forecastReads, 0);
    const read = await f.keeper.openRead(g.capability, PHONE);
    const result = await f.keeper.read(g.capability, PHONE, read.readId);
    assert.equal(result.logging, false);
    assert.equal(result.basis, 'private-instrument-agreement');
    assert(result.scores.every((v) => v.status === 'warming' && v.closest === null));
    await assert.rejects(f.keeper.enable(g.capability, PHONE));
});

test('a confirmed opt-in stays OFF until the phone demonstrates receipt of the opaque stop capability', async () => {
    const f = fixture(),
        p = await f.keeper.prepare({ schema: 1, vesselId: VESSEL }, PHONE, 'synthetic');
    const grant = await f.keeper.confirm({ schema: 1, nonce: p.nonce, logging: true }, PHONE, 'synthetic');
    assert.equal(f.control.active?.loggingApproved, true);
    assert.equal(f.control.active?.logging, false);
    await f.keeper.tick();
    assert.equal(f.mutations.forecastReads, 0);
    assert.equal(f.mutations.samples, 0);
    await f.keeper.enable(grant.capability, PHONE);
    await f.keeper.tick();
    assert.equal(f.control.active?.logging, true);
    assert.equal(f.mutations.samples, 1);
});
test('nonce and consent/read clocks have fixed bounds without renewal from reading', async () => {
    const f = fixture(),
        g = await f.grant();
    assert.equal(g.consent.expiresAt - g.consent.issuedAt, LIMIT.consentMs);
    const read = await f.keeper.openRead(g.capability, PHONE);
    assert.equal(read.expiresAt - g.consent.issuedAt, LIMIT.readMs);
    f.advance(0, LIMIT.readMs);
    await assert.rejects(f.keeper.read(g.capability, PHONE, read.readId));
    assert.equal(f.control.active?.consent.expiresAt, g.consent.expiresAt);
});
test('monotonic prepare expiry refuses a frozen wall clock and nonce replay', async () => {
    const f = fixture(),
        p = await f.keeper.prepare({ schema: 1, vesselId: VESSEL }, PHONE, 'synthetic');
    f.advance(0, LIMIT.prepareMs);
    await assert.rejects(f.keeper.confirm({ schema: 1, nonce: p.nonce, logging: true }, PHONE, 'synthetic'));
    await assert.rejects(f.keeper.confirm({ schema: 1, nonce: p.nonce, logging: true }, PHONE, 'synthetic'));
    assert.equal(f.control.active, null);
});
test('clock rollback refuses reads while the privacy OFF remains usable and durable', async () => {
    const f = fixture(),
        g = await f.grant(),
        r = await f.keeper.openRead(g.capability, PHONE);
    f.advance(-2000, 1000);
    await assert.rejects(f.keeper.read(g.capability, PHONE, r.readId));
    assert.equal(f.keeper.off(g.capability, PHONE).state, 'off');
    assert.equal(f.control.active, null);
    assert.equal(f.control.blockedRevision, g.consent.revision);
    f.advance(2000);
    await assert.rejects(f.keeper.openRead(g.capability, PHONE));
    const restarted = new OwnBoatSkillKeeper(f.deps);
    await assert.rejects(restarted.openRead(g.capability, PHONE));
});
test('consent expires on monotonic time even if the wall clock stops moving', async () => {
    const f = fixture();
    await f.grant();
    f.advance(0, LIMIT.consentMs);
    await f.keeper.tick();
    assert.equal(f.control.active, null);
    assert.equal(f.mutations.samples, 0);
});
test('forged capability and a different controller never read private evidence', async () => {
    const f = fixture(),
        g = await f.grant();
    await assert.rejects(f.keeper.openRead('f'.repeat(64), PHONE));
    await assert.rejects(f.keeper.openRead(g.capability, PI));
    assert.throws(() => f.keeper.off(g.capability, PI));
    assert(f.control.active);
});
test('quiet instruments hold logging and disclose unavailability without fabricating samples', async () => {
    const f = fixture(),
        g = await f.grant();
    f.setSource(null);
    await f.keeper.tick();
    assert(f.control.active);
    assert.equal(f.mutations.samples, 0);
    assert.equal(f.mutations.forecastReads, 0);
    const r = await f.keeper.openRead(g.capability, PHONE);
    assert.match((await f.keeper.read(g.capability, PHONE, r.readId)).phase, /unavailable/);
});
test('a real source/boat identity change retires consent instead of overwriting its association', async () => {
    const f = fixture(),
        g = await f.grant();
    f.setSource({ ...f.source!, selfKey: 'f'.repeat(64) });
    await f.keeper.tick();
    assert.equal(f.control.active, null);
    assert.equal(f.control.blockedRevision, g.consent.revision);
    assert.equal(f.mutations.samples, 0);
});
test('relay A/B/A is persistently OFF even without a live instrument read', async () => {
    const f = fixture(),
        g = await f.grant();
    const a = { ownerId: OWNER, relayId: 'relay-a', token: 'token-a' },
        b = { ...a, token: 'token-b' };
    f.keeper.relayChanged(a, b);
    f.keeper.relayChanged(b, a);
    assert.equal(f.control.active, null);
    assert.equal(f.control.blockedRevision, g.consent.revision);
    await assert.rejects(new OwnBoatSkillKeeper(f.deps).openRead(g.capability, PHONE));
});
test('late context from a retired read cannot stop a newer confirmed consent', async () => {
    const f = fixture(),
        old = await f.grant(),
        normal = f.deps.context;
    let finish: (v: OwnSkillContext | null) => void = () => {};
    f.deps.context = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const waiting = f.keeper.openRead(old.capability, PHONE);
    f.keeper.off(old.capability, PHONE);
    f.deps.context = normal;
    const successor = await f.grant();
    finish(null);
    await assert.rejects(waiting);
    assert.equal(f.control.active?.consent.revision, successor.consent.revision);
});
test('OFF during original forecast await prevents every late sample/capture write', async () => {
    const f = fixture(),
        g = await f.grant();
    let finish: () => void = () => {};
    f.deps.forecasts.read = async () => {
        await new Promise<void>((resolve) => {
            finish = resolve;
        });
        return null;
    };
    const ticking = f.keeper.tick();
    await new Promise((resolve) => setImmediate(resolve));
    f.keeper.off(g.capability, PHONE);
    finish();
    await ticking;
    assert.equal(f.mutations.captures, 0);
    assert.equal(f.mutations.samples, 0);
    assert.equal(f.control.active, null);
});
test('internet OFF keeps instrument logging local with no paid/public forecast calls', async () => {
    const f = fixture();
    await f.grant();
    f.setInternet(false);
    await f.keeper.tick();
    assert.equal(f.mutations.forecastReads, 0);
    assert.equal(f.mutations.samples, 1);
});
test('hourly acquisition budget is claimed once across repeated logger passes', async () => {
    const f = fixture();
    await f.grant();
    await f.keeper.tick();
    await f.keeper.tick();
    assert.equal(f.mutations.forecastReads, 6);
    assert.equal(f.mutations.samples, 2);
});

test('controller retirement during original HTTP await is re-read before retaining any capture', async () => {
    const f = fixture();
    await f.grant();
    let finish: (v: never) => void = () => {};
    f.deps.forecasts.read = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const ticking = f.keeper.tick();
    await new Promise((resolve) => setImmediate(resolve));
    f.deps.context = async () => null;
    finish({ synthetic: 'non-adoptable original' } as never);
    await ticking;
    assert.equal(f.mutations.captures, 0);
    assert.equal(f.mutations.samples, 0);
    assert.equal(f.control.active, null);
});

test('late owner proof cannot mint logging consent after the native request deadline', async () => {
    const f = fixture(),
        p = await f.keeper.prepare({ schema: 1, vesselId: VESSEL }, PHONE, 'synthetic'),
        normal = f.deps.owner.verify;
    f.deps.owner.verify = async (...args) => {
        const owner = await normal(...args);
        f.advance(0, LIMIT.ownerProofMs + 1);
        return owner;
    };
    await assert.rejects(f.keeper.confirm({ schema: 1, nonce: p.nonce, logging: true }, PHONE, 'synthetic'));
    assert.equal(f.control.active, null);
});
