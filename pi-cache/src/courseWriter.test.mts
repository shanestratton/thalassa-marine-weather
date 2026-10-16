import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCourseWriter, type CourseWriterTransport, type OwnedCourse } from './courseWriter.js';
const T = Date.parse('2026-10-16T11:00:00Z');
const ROUTE = {
    key: 'follow-1',
    name: 'Fictional route',
    points: [
        { lat: 30, lon: 179.9 },
        { lat: 30.1, lon: -179.8 },
    ],
};
function fixture() {
    type Resource = { name: string; feature: { geometry: { type: string; coordinates: number[][] } } };
    type Course = {
        startTime: string | null;
        activeRoute: { href: string } | null;
        nextPoint: { position: { latitude: number; longitude: number } } | null;
        previousPoint: null;
    };
    const empty = (): Course => ({ startTime: null, activeRoute: null, nextPoint: null, previousPoint: null });
    const data = {
        now: T,
        allowed: true,
        engaged: false,
        current: empty(),
        resources: new Map<string, Resource>(),
        claims: [] as OwnedCourse[],
        requests: [] as Array<{ method: string; target: string; body?: unknown }>,
        loseActivationReply: false,
        corruptRoute: false,
        expireOnSavedRead: false,
        changeOnSave: false,
    };
    const transport: CourseWriterTransport = {
        async requestCourse(request) {
            data.requests.push(structuredClone(request));
            if (request.target === 'course' && request.method === 'GET') return structuredClone(data.current);
            if (request.target === 'route' && request.method === 'PUT') {
                data.resources.set(request.routeId!, structuredClone(request.body as Resource));
                if (data.changeOnSave)
                    data.current = { ...empty(), nextPoint: { position: { latitude: 32, longitude: -61 } } };
                return {};
            }
            if (request.target === 'route' && request.method === 'GET') {
                if (data.expireOnSavedRead) data.now += 31_000;
                const result = structuredClone(data.resources.get(request.routeId!)!);
                if (data.corruptRoute) result.feature.geometry.coordinates[1][0] += 0.1;
                return result;
            }
            if (request.target === 'activeRoute' && request.method === 'PUT') {
                data.current = {
                    startTime: new Date(data.now).toISOString(),
                    activeRoute: request.body as { href: string },
                    nextPoint: { position: { latitude: 30, longitude: 179.9 } },
                    previousPoint: null,
                };
                if (data.loseActivationReply) throw Error('Connection lost after write');
                return {};
            }
            if (request.target === 'course' && request.method === 'DELETE') {
                data.current = empty();
                return {};
            }
            throw Error('Unexpected operation');
        },
    };
    const writer = createCourseWriter({
        transport,
        store: {
            read: () => structuredClone(data.claims),
            write: (value) => {
                data.claims = structuredClone(value);
            },
        },
        now: () => data.now,
        allowed: () => data.allowed,
        pilotEngaged: () => data.engaged,
    });
    const activate = async () => {
        const p = await writer.preview('device-a', ROUTE);
        return writer.activate('device-a', { ...p, pilotInStandby: true, replaceExisting: true });
    };
    return { writer, data, activate };
}
test('exact dateline route is verified aboard before activation; only owned navigation is cleared', async () => {
    const { writer, data, activate } = fixture();
    const result = await activate();
    assert.equal(result.active, true);
    const stored = data.resources.get(result.resourceId)!;
    assert.deepEqual(stored.feature.geometry.coordinates, [
        [179.9, 30],
        [-179.8, 30.1],
    ]);
    assert.equal(data.claims[0].phase, 'active');
    assert.equal((await writer.clear('device-b', 'follow-1')).cleared, false);
    assert.equal(data.requests.filter((r) => r.method === 'DELETE').length, 0);
    assert.equal((await writer.clear('device-a', 'follow-1')).cleared, true);
    assert.equal(data.claims.length, 0);
    assert.equal(data.requests.filter((r) => r.target === 'activeRoute' && r.method === 'PUT').length, 1);
});
test('preview is immutable and read-only, and its one-use token cannot be replayed', async () => {
    const { writer, data } = fixture();
    const route = structuredClone(ROUTE);
    const p = await writer.preview('device-a', route);
    route.points[1].lon = 0;
    assert.deepEqual(
        data.requests.map((r) => r.method),
        ['GET'],
    );
    const result = await writer.activate('device-a', { ...p, pilotInStandby: true, replaceExisting: false });
    assert.equal(data.resources.get(result.resourceId)!.feature.geometry.coordinates[1][0], -179.8);
    await assert.rejects(writer.activate('device-a', { ...p, pilotInStandby: true, replaceExisting: false }), /again/);
});
test('a missing standby interlock or reported engaged pilot makes no write', async () => {
    const { writer, data } = fixture();
    const p = await writer.preview('device-a', ROUTE);
    await assert.rejects(
        writer.activate('device-a', { ...p, pilotInStandby: false, replaceExisting: false }),
        /standby/,
    );
    data.engaged = true;
    await assert.rejects(
        writer.activate('device-a', { ...p, pilotInStandby: true, replaceExisting: false }),
        /standby/,
    );
    assert.equal(
        data.requests.some((r) => r.method !== 'GET'),
        false,
    );
});
test('changed course, authority or expired confirmation refuses activation', async () => {
    for (const failure of ['course', 'authority', 'expired'] as const) {
        const { writer, data } = fixture();
        const p = await writer.preview('device-a', ROUTE);
        if (failure === 'course') data.current.nextPoint = { position: { latitude: 31, longitude: -60 } };
        if (failure === 'authority') data.allowed = false;
        if (failure === 'expired') data.now += 31_000;
        await assert.rejects(writer.activate('device-a', { ...p, pilotInStandby: true, replaceExisting: true }));
        assert.equal(
            data.requests.some((r) => r.method !== 'GET'),
            false,
        );
    }
});
test('changed geometry, a later helm change or confirmation expiring during a read never activates', async () => {
    for (const failure of ['geometry', 'helm', 'expiry'] as const) {
        const { data, activate } = fixture();
        data.corruptRoute = failure === 'geometry';
        data.changeOnSave = failure === 'helm';
        data.expireOnSavedRead = failure === 'expiry';
        await assert.rejects(activate());
        assert.equal(
            data.requests.some((r) => r.target === 'activeRoute'),
            false,
        );
    }
});
test('lost activation reply retains an uncertain claim that can be reconciled and cleared without another upload', async () => {
    const { writer, data, activate } = fixture();
    data.loseActivationReply = true;
    await assert.rejects(activate(), /Connection lost/);
    assert.equal(data.claims[0].phase, 'activating');
    assert.equal((await writer.clear('device-a', 'follow-1')).cleared, true);
    assert.equal(data.requests.filter((r) => r.target === 'activeRoute').length, 1);
});
test('another helm’s route is left untouched and only the stale owned claim is retired', async () => {
    const { writer, data, activate } = fixture();
    await activate();
    data.current.activeRoute = { href: '/resources/routes/22222222-2222-4222-8222-222222222222' };
    assert.deepEqual(await writer.clear('device-a', 'follow-1'), { cleared: false, reason: 'course-changed' });
    assert.equal(
        data.requests.some((r) => r.method === 'DELETE'),
        false,
    );
    assert.equal(data.claims.length, 0);
});
test('an unsuccessful replacement keeps the earlier owned course claim', async () => {
    const { writer, data, activate } = fixture();
    await activate();
    const previous = data.claims[0];
    data.loseActivationReply = true;
    const p = await writer.preview('device-a', { ...ROUTE, key: 'follow-2' });
    await assert.rejects(writer.activate('device-a', { ...p, pilotInStandby: true, replaceExisting: true }));
    assert.equal(data.claims.length, 2);
    assert.deepEqual(data.claims[0], previous);
    assert.equal((await writer.clear('device-a', 'follow-1')).cleared, false);
    assert.equal(data.claims.length, 1);
    assert.equal(data.claims[0].routeKey, 'follow-2');
});
