import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InternetAisPublisher, internetAisAuthority, internetAisFix } from './publisher.js';
import type { InternetAisAuthority } from './publisher.js';
const at = Date.parse('2026-10-17T09:00:00Z');
const input = {
    enabled: true,
    reviewed: true,
    allowInternet: true,
    generation: 1,
    credentials: {
        ownerId: '11111111-1111-4111-8111-111111111111',
        relayId: 'synthetic-relay-0001',
        token: 'a'.repeat(64),
    },
    anonKey: 'synthetic-anon',
};
const fix = { lat: -27.2, lon: 153.1, measuredAt: at - 1000, ownMmsi: 503111111, sourceKey: 'synthetic-self:position' };
const target = { mmsi: 503222222, lat: -27.21, lon: 153.11, cog: 90, sog: 10, at: at - 3000, provider: 'aisstream' };
const reply = () => ({ schema: 1, targets: [{ ...target }], coverage: 'limited', truncated: false });
function harness() {
    let authority: InternetAisAuthority | null = internetAisAuthority(input),
        now = at,
        retired = 0;
    const lines: string[] = [];
    const deps = {
        authority: () => authority,
        fix: async () => ({ ...fix }),
        fetch: async () => reply() as unknown,
        emit: (line: string, current: () => boolean) => {
            if (current()) lines.push(line);
        },
        retire: () => {
            retired++;
        },
        now: () => now,
    };
    return {
        deps,
        lines,
        runner: new InternetAisPublisher(deps),
        authority: (value: InternetAisAuthority | null) => {
            authority = value;
        },
        time: (value: number) => {
            now = value;
        },
        retired: () => retired,
    };
}
test('only explicit reviewed opt-in, internet permission and actual current scoped authority admit export', () => {
    assert.ok(internetAisAuthority(input));
    for (const extra of [
        { enabled: false },
        { reviewed: false },
        { allowInternet: false },
        { generation: null },
        { credentials: null },
        { anonKey: '' },
    ])
        assert.equal(internetAisAuthority({ ...input, ...extra }), null);
    assert.notEqual(internetAisAuthority(input)?.key, internetAisAuthority({ ...input, generation: 3 })?.key);
});
test('own fix must be original fresh selected instrument position with a known own MMSI, not the internet source', () => {
    const doc = {
        uuid: 'urn:mrn:signalk:uuid:11111111-1111-4111-8111-111111111111',
        mmsi: '503111111',
        navigation: {
            position: {
                $source: 'gps.local',
                timestamp: new Date(at - 1000).toISOString(),
                value: { latitude: fix.lat, longitude: fix.lon },
            },
        },
    };
    assert.ok(internetAisFix(doc, at));
    assert.equal(internetAisFix({ ...doc, mmsi: null }, at), null);
    assert.equal(internetAisFix(doc, at + 30000), null);
    doc.navigation.position.$source = 'thalassa-internet-ais.aisstream';
    assert.equal(internetAisFix(doc, at), null);
});
test('successful current poll emits tagged original-time JSON and suppresses repeated observations without an offline backlog', async () => {
    const h = harness();
    await h.runner.poll();
    assert.equal(h.lines.length, 1);
    assert.ok(h.lines[0].endsWith('\r\n'));
    assert.equal(JSON.parse(h.lines[0]).updates[0].timestamp, new Date(target.at).toISOString());
    await h.runner.poll();
    assert.equal(h.lines.length, 1);
    h.authority(null);
    h.runner.refresh();
    await h.runner.poll();
    assert.equal(h.lines.length, 1);
    assert.equal(h.retired(), 2);
    h.runner.close();
});
test('delayed fetch cannot emit after owner/policy A→B→A even when old credentials are restored', async () => {
    const h = harness();
    let ready!: () => void, release!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => {
        ready = resolve;
    });
    h.deps.fetch = async () => {
        ready();
        return new Promise((resolve) => {
            release = resolve;
        });
    };
    const poll = h.runner.poll();
    await started;
    h.authority(internetAisAuthority({ ...input, generation: 2 }));
    h.runner.refresh();
    h.authority(internetAisAuthority({ ...input, generation: 3 }));
    h.runner.refresh();
    release(reply());
    await poll;
    assert.equal(h.lines.length, 0);
    h.runner.close();
});
test('final source replacement, report ageing and authority retirement between two emitted lines all refuse adoption', async () => {
    const h = harness();
    let reads = 0;
    h.deps.fix = async () => ({ ...fix, sourceKey: ++reads === 1 ? fix.sourceKey : 'replacement' });
    await h.runner.poll();
    assert.equal(h.lines.length, 0);
    h.deps.fix = async () => ({ ...fix });
    h.deps.fetch = async () => {
        h.time(at + 120001);
        return reply();
    };
    await h.runner.poll();
    assert.equal(h.lines.length, 0);
    h.time(at);
    h.deps.fetch = async () => ({ ...reply(), targets: [target, { ...target, mmsi: 503333333 }] });
    h.deps.emit = (line, current) => {
        if (current()) {
            h.lines.push(line);
            h.authority(null);
        }
    };
    await h.runner.poll();
    assert.equal(h.lines.length, 1);
    h.runner.close();
});
test('retiring a never-resolving response promptly ends the owned poll and closes without re-emission', async () => {
    const h = harness();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
        ready = resolve;
    });
    h.deps.fetch = async () => {
        ready();
        return new Promise(() => undefined);
    };
    const poll = h.runner.poll();
    await started;
    h.runner.close();
    await poll;
    assert.equal(h.lines.length, 0);
});
