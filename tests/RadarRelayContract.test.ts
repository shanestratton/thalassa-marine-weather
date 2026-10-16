import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/radar-relay137.json';
import {
    radarRelayKeyCanonical,
    RADAR_RELAY_BATCH,
    RADAR_RELAY_CONTACT,
    RADAR_RELAY_EPISODE,
    RADAR_RELAY_KEY,
    type RadarRelayContext,
    type RadarRelayUpsert,
} from '../utils/radarRelayContract';
const context = fixture.context as RadarRelayContext,
    alarm = fixture.alarm as RadarRelayUpsert;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
describe('portable fixed radar relay identity', () => {
    it('pins exact canonical bytes and generated hash for phone/Pi/Edge', () => {
        expect(radarRelayKeyCanonical(context, alarm)).toBe(fixture.canonical);
        expect(sha(fixture.canonical)).toBe(fixture.sha256);
        expect(alarm.key).toBe(`${alarm.kind}:${fixture.sha256.slice(0, 12)}:${alarm.raisedAt}`);
        expect(RADAR_RELAY_CONTACT.test(alarm.contactKey)).toBe(true);
        expect(RADAR_RELAY_EPISODE.test(alarm.episodeId)).toBe(true);
        expect(RADAR_RELAY_KEY.test(alarm.key)).toBe(true);
    });
    it('makes device, vessel, pairing, configuration, instance, episode, source and severity distinct', () => {
        const original = sha(radarRelayKeyCanonical(context, alarm));
        for (const key of Object.keys(context.binding) as (keyof RadarRelayContext['binding'])[])
            expect(
                sha(
                    radarRelayKeyCanonical(
                        { ...context, binding: { ...context.binding, [key]: context.binding[key] + 'other' } },
                        alarm,
                    ),
                ),
            ).not.toBe(original);
        for (const key of ['configurationRevision', 'instance'] as const)
            expect(sha(radarRelayKeyCanonical({ ...context, [key]: context[key] + 'other' }, alarm))).not.toBe(
                original,
            );
        for (const patch of [
            { episodeId: context.watchEpoch + ':2' },
            { contactKey: alarm.contactKey.replace(':RA:1', ':RA:2') },
            { raisedAt: alarm.raisedAt + 1 },
            { kind: 'radar-close-quarters' as const },
        ])
            expect(sha(radarRelayKeyCanonical(context, { ...alarm, ...patch }))).not.toBe(original);
        // Updated measurements age an existing episode; they do not become a new raise/key.
        expect(radarRelayKeyCanonical(context, { ...alarm, sourceAt: alarm.sourceAt + 1000 } as RadarRelayUpsert)).toBe(
            fixture.canonical,
        );
    });
    it('cannot use numeric AIS identities or another transport namespace', () => {
        for (const key of [
            '123456789',
            'radar:gateway:' + 'e'.repeat(32) + ':RA:1',
            alarm.contactKey + ':extra',
            alarm.contactKey.replace(':RA:1', ':RA:1000'),
        ])
            expect(RADAR_RELAY_CONTACT.test(key)).toBe(false);
        for (const id of [context.watchEpoch + ':0', context.watchEpoch + ':1000000000', 'other:1'])
            expect(RADAR_RELAY_EPISODE.test(id)).toBe(false);
    });
    it('fits a full bounded batch under the unchanged shared8KiB door, with no position/frame fields', () => {
        const body = {
            family: 'radar',
            action: 'sync',
            context,
            contextRevision: context.configurationRevision,
            evaluatedAt: alarm.raisedAt,
            upserts: Array.from({ length: RADAR_RELAY_BATCH }, () => alarm),
            acks: [],
            resolved: [],
            more: true,
        };
        const text = JSON.stringify(body);
        expect(Buffer.byteLength(text)).toBeLessThan(8192);
        expect(text).not.toMatch(/"(?:lat|lon|latitude|longitude|sentence|name|path|receivedAt)"/);
    });
});
