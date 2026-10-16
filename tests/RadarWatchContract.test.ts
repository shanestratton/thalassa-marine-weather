import { describe, expect, it } from 'vitest';
import fixture from './fixtures/radar-relay137.json';
import { radarContextKey, validRadarContext, validRadarController, validRadarOwner } from '../utils/radarWatchContract';
describe('paired radar controller/context contract', () => {
    it('uses the actual portable relay fixture and rejects incomplete or extended identities', () => {
        const context = fixture.context;
        expect(validRadarContext(context)).toBe(true);
        expect(validRadarContext({ ...context, ownerId: context.binding.ownerId })).toBe(false);
        expect(validRadarContext({ ...context, binding: { ...context.binding, feedId: 'pi:unverified' } })).toBe(false);
        expect(validRadarContext({ ...context, watchEpoch: 'not-an-epoch' })).toBe(false);
        expect(
            validRadarController({
                deviceId: context.binding.deviceId,
                enrollmentRevision: context.binding.enrollmentRevision,
            }),
        ).toBe(true);
        expect(validRadarController({ deviceId: context.binding.deviceId, enrollmentRevision: 'old' })).toBe(false);
    });
    it('compares exact context identity independently of property ordering', () => {
        const c = fixture.context;
        expect(
            radarContextKey({
                watchEpoch: c.watchEpoch,
                instance: c.instance,
                configurationRevision: c.configurationRevision,
                binding: { ...c.binding },
            }),
        ).toBe(radarContextKey(c));
        expect(radarContextKey({ ...c, watchEpoch: 'b'.repeat(32) })).not.toBe(radarContextKey(c));
        expect(radarContextKey({ ...c, binding: { ...c.binding, enrollmentRevision: 'a'.repeat(64) } })).not.toBe(
            radarContextKey(c),
        );
    });
});

it('owner envelope is exactly server-owned account/Pi/pair/self identity', () => {
    const b = fixture.context.binding;
    const owner = { ownerId: b.ownerId, piDeviceId: b.piDeviceId, pairingId: b.pairingId, feedId: b.feedId };
    expect(validRadarOwner(owner)).toBe(true);
    expect(validRadarOwner({ ...owner, contextToken: 'private-root-token' })).toBe(false);
    expect(validRadarOwner({ ...owner, pairingId: 'unverified' })).toBe(false);
});
