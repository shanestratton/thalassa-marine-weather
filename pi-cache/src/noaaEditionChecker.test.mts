import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    NoaaEditionChecker,
    NoaaEditionFileState,
    installedNoaaEditions,
    type NoaaEditionOwner,
    type NoaaEditionNotice,
    type NoaaEditionState,
} from './noaaEditionChecker.js';
import { NOAA_AGREEMENT_SHA256, NOAA_AGREEMENT_URL } from './noaaEdition/noaaAgreementIdentity.js';
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const binding: NoaaEditionOwner = { ownerId: uuid(1), piDeviceId: uuid(2), pairingId: uuid(3), revision: uuid(4) };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
    let now = Date.now(),
        context: NoaaEditionOwner | null = { ...binding },
        net = true,
        saved: NoaaEditionState | null = null;
    const generation = 'a'.repeat(24),
        checkedAt = new Date(now).toISOString();
    let revisions = Buffer.from(
        JSON.stringify({
            schema: 1,
            generation,
            cells: [{ id: 'US5TEST1', edition: 2, update: 3, issued: '2026-10-16', baseIssued: '2026-10-15' }],
        }),
    );
    const index = {
        schema: 1,
        generation,
        checkedAt,
        sourceAt: checkedAt,
        sourceSha256: 'f'.repeat(64),
        sourceUrl: 'https://charts.noaa.gov/ENCs/ENCProdCat_19115.xml',
        agreementUrl: NOAA_AGREEMENT_URL,
        agreementSha256: NOAA_AGREEMENT_SHA256,
        activeCells: 1,
        withdrawn: [],
        attribution: 'Public NOAA metadata',
        shards: [],
        revisions: {
            key: `generations/${generation}/revisions.json`,
            bytes: revisions.length,
            sha256: hash(revisions),
        },
    };
    const requests: string[] = [],
        notices: NoaaEditionNotice[] = [];
    const deps = {
        context: () => context,
        internetAllowed: () => net,
        now: () => now,
        installed: async () => [{ cellId: 'US5TEST1', sourceHO: 'US', licence: 'open', edition: 1, updateNumber: 0 }],
        store: {
            load: async (namespace: string) =>
                structuredClone(
                    saved ?? {
                        schema: 1,
                        namespace,
                        lastAttemptAt: 0,
                        lastCheckedAt: 0,
                        sourceAt: null,
                        checkedAt: null,
                        day: '',
                        sent: 0,
                        pending: 0,
                        incomplete: false,
                        notified: [],
                    },
                ),
            save: async (value: NoaaEditionState) => {
                saved = structuredClone(value);
            },
        },
        fetch: async (url: RequestInfo | URL) => {
            requests.push(String(url));
            return new Response(String(url).endsWith('/index.json') ? JSON.stringify(index) : revisions);
        },
        notify: async (packet: NoaaEditionNotice) => {
            notices.push(packet);
            return true;
        },
    };
    return {
        deps,
        index,
        revisions,
        requests,
        notices,
        setContext: (value: NoaaEditionOwner | null) => {
            context = value;
        },
        setNet: (v: boolean) => {
            net = v;
        },
        advance: (ms: number) => {
            now += ms;
        },
        setClock: (value: number) => {
            now = value;
        },
        setRevisions: (
            cells: Array<{ id: string; edition: number; update: number; issued: string; baseIssued: string }>,
        ) => {
            revisions = Buffer.from(JSON.stringify({ schema: 1, generation, cells }));
            index.activeCells = cells.length;
            index.revisions.bytes = revisions.length;
            index.revisions.sha256 = hash(revisions);
        },
        saved: () => saved,
    };
}
test('fixed two-request public metadata check preserves original dates, dedupes across restart and never fetches chart blobs', async () => {
    const f = fixture();
    let keeper = new NoaaEditionChecker(f.deps);
    await keeper.tick();
    assert.equal(keeper.status.state, 'checked');
    assert.equal(f.notices.length, 1);
    assert.deepEqual(f.notices[0].changes[0].available, {
        id: 'US5TEST1',
        edition: 2,
        update: 3,
        issued: '2026-10-16',
        baseIssued: '2026-10-15',
    });
    assert.equal(f.notices[0].checkedAt, f.index.checkedAt);
    assert.equal(f.requests.length, 2);
    assert.ok(
        f.requests.every((url) =>
            /^https:\/\/tiles\.thalassatiles\.com\/noaa-enc\/v1\/(index\.json|generations\/[a-f0-9]{24}\/revisions\.json)$/.test(
                url,
            ),
        ),
    );
    keeper = new NoaaEditionChecker(f.deps);
    await keeper.tick();
    assert.equal(f.requests.length, 2);
    f.advance(86400000);
    await keeper.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(f.requests.length, 4);
});
test('absent, corrupt, stale and partial revision cohorts remain unavailable without sending', async () => {
    for (const mode of ['absent', 'hash', 'stale', 'incomplete'] as const) {
        const f = fixture();
        if (mode === 'absent') delete (f.index as { revisions?: unknown }).revisions;
        if (mode === 'hash') f.index.revisions.sha256 = '0'.repeat(64);
        if (mode === 'stale') f.advance(9 * 86400000);
        if (mode === 'incomplete') f.index.activeCells = 2;
        const keeper = new NoaaEditionChecker(f.deps);
        await keeper.tick();
        assert.equal(f.notices.length, 0, mode);
        assert.ok(['unavailable', 'incomplete'].includes(keeper.status.state), mode);
    }
});
test('owner/pairing loss during await suppresses the old receipt and retires status immediately', async () => {
    const f = fixture();
    let done!: (rows: Awaited<ReturnType<typeof f.deps.installed>>) => void;
    f.deps.installed = () =>
        new Promise((resolve) => {
            done = resolve;
        });
    const keeper = new NoaaEditionChecker(f.deps),
        pending = keeper.tick();
    await new Promise((resolve) => setImmediate(resolve));
    f.setContext({ ...binding, pairingId: uuid(9) });
    assert.equal(keeper.status.state, 'held');
    done([{ cellId: 'US5TEST1', sourceHO: 'US', licence: 'open', edition: 1, updateNumber: 0 }]);
    await pending;
    assert.equal(f.requests.length, 0);
    assert.equal(f.notices.length, 0);
});
test('internet policy and explicit stop block requests; a dependency ignoring AbortSignal cannot retain the checker', async () => {
    const f = fixture();
    f.setNet(false);
    const keeper = new NoaaEditionChecker(f.deps);
    await keeper.tick();
    assert.equal(f.requests.length, 0);
    f.setNet(true);
    f.deps.installed = () => new Promise(() => {});
    const pending = keeper.tick();
    await new Promise((resolve) => setImmediate(resolve));
    keeper.stop();
    await pending;
    assert.equal(keeper.status.state, 'held');
    assert.equal(f.requests.length, 0);
});
test('unknown installed update does not become zero or an all-current claim; delivery remains held without a sender', async () => {
    const f = fixture();
    f.deps.installed = async () => [
        {
            cellId: 'US5TEST1',
            sourceHO: 'US',
            licence: 'open',
            edition: 2,
            updateNumber: undefined as unknown as number,
        },
    ];
    const keeper = new NoaaEditionChecker({ ...f.deps, notify: undefined });
    await keeper.tick();
    assert.equal(keeper.status.state, 'incomplete');
    assert.equal(f.notices.length, 0);
    const g = fixture(),
        held = new NoaaEditionChecker({ ...g.deps, notify: undefined });
    await held.tick();
    assert.equal(held.status.pending, 1);
    assert.equal(held.status.deliveryHeld, true);
    await held.tick();
    assert.equal(held.status.pending, 1);
});
test('persistent reader preserves corrupt dedupe state and reads only bounded open NOAA metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noaa-edition-'));
    try {
        const store = new NoaaEditionFileState(dir);
        await fs.writeFile(path.join(dir, 'noaa-editions-v1.json'), '{bad');
        await assert.rejects(store.load('a'.repeat(64)));
        assert.equal(await fs.readFile(path.join(dir, 'noaa-editions-v1.json'), 'utf8'), '{bad');
        await fs.writeFile(
            path.join(dir, 'index.json'),
            JSON.stringify({
                version: 1,
                cells: [
                    { cellId: 'US5TEST1', sourceHO: 'US', source: 'phone-upload', edition: 1 },
                    { cellId: 'AU5TEST1', sourceHO: 'AU', source: 'pi-decrypt', edition: 1 },
                ],
            }),
        );
        const rows = await installedNoaaEditions(dir);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].licence, 'open');
        assert.equal(rows[0].updateNumber, undefined);
        await fs.writeFile(path.join(dir, 'index.json'), ' '.repeat(2 * 1024 * 1024 + 1));
        await assert.rejects(installedNoaaEditions(dir), /cap/);
    } finally {
        const resolved = path.resolve(dir);
        if (
            path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
            !path.basename(resolved).startsWith('noaa-edition-')
        )
            throw Error('Refusing cleanup outside the owned temporary directory');
        await fs.rm(resolved, { recursive: true, force: true });
    }
});
test('bounded eight-cell summaries preserve more and pending across daily checks without duplicate revision notices', async () => {
    const f = fixture();
    const rows = Array.from({ length: 20 }, (_, i) => ({
        id: `US5${String(i).padStart(5, '0')}`,
        edition: 2,
        update: 3,
        issued: '2026-10-16',
        baseIssued: '2026-10-15',
    }));
    f.setRevisions(rows);
    f.deps.installed = async () =>
        rows.map((n) => ({ cellId: n.id, sourceHO: 'US', licence: 'open', edition: 1, updateNumber: 0 }));
    const keeper = new NoaaEditionChecker(f.deps);
    await keeper.tick();
    assert.equal(f.notices[0].changes.length, 8);
    assert.equal(f.notices[0].more, true);
    assert.equal(keeper.status.pending, 12);
    await keeper.tick();
    assert.equal(f.requests.length, 2);
    for (const expected of [4, 0]) {
        f.advance(86400000);
        await keeper.tick();
        assert.equal(keeper.status.pending, expected);
    }
    assert.deepEqual(
        f.notices.map((n) => n.more),
        [true, true, false],
    );
    const ids = f.notices.flatMap((n) => n.changes.map((c) => c.key));
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20);
    assert.equal(f.saved()!.notified.length, 20);
});
test('daily receipt quota and full dedupe ledger hold unsent changes before calling a sender', async () => {
    const f = fixture();
    await new NoaaEditionChecker(f.deps).tick();
    const saved = f.saved()!;
    saved.lastAttemptAt = 0;
    saved.lastCheckedAt = 0;
    saved.sent = 2;
    f.setRevisions([{ id: 'US5NEW01', edition: 2, update: 1, issued: '2026-10-16', baseIssued: '2026-10-15' }]);
    f.deps.installed = async () => [
        { cellId: 'US5NEW01', sourceHO: 'US', licence: 'open', edition: 1, updateNumber: 0 },
    ];
    const keeper = new NoaaEditionChecker(f.deps);
    await keeper.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(keeper.status.pending, 1);
    assert.equal(keeper.status.deliveryHeld, true);
    const ledger = f.saved()!;
    ledger.lastAttemptAt = 0;
    ledger.lastCheckedAt = 0;
    ledger.sent = 0;
    ledger.notified = Array.from({ length: 10000 }, (_, i) => ({
        id: `US5${String(i).padStart(5, '0')}`,
        edition: 1,
        update: 0,
    }));
    await keeper.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(keeper.status.state, 'unavailable');
    assert.equal(f.saved()!.notified.length, 10000);
    assert.equal(f.saved()!.notified[0].id, 'US500000');
});
test('invalid/backward clocks and oversized response streams do not send or renew prior proof', async () => {
    for (const clock of [NaN, Infinity, 0, -1]) {
        const f = fixture();
        f.setClock(clock);
        await new NoaaEditionChecker(f.deps).tick();
        assert.equal(f.requests.length, 0);
        assert.equal(f.saved(), null);
    }
    const f = fixture(),
        keeper = new NoaaEditionChecker(f.deps);
    await keeper.tick();
    const checked = f.saved()!.checkedAt;
    f.advance(-1000);
    await keeper.tick();
    assert.equal(f.requests.length, 2);
    assert.equal(f.notices.length, 1);
    assert.equal(f.saved()!.checkedAt, checked);
    for (const mode of ['root', 'revision']) {
        const g = fixture();
        g.deps.fetch = async (url) => {
            g.requests.push(String(url));
            return new Response(
                String(url).endsWith('/index.json') && mode === 'revision'
                    ? JSON.stringify(g.index)
                    : ' '.repeat(mode === 'root' ? 256 * 1024 + 1 : 1024 * 1024 + 1),
            );
        };
        const checker = new NoaaEditionChecker(g.deps);
        await checker.tick();
        assert.equal(checker.status.state, 'unavailable');
        assert.equal(g.notices.length, 0);
        assert.equal(g.requests.length, mode === 'root' ? 1 : 2);
        assert.equal(g.saved()!.checkedAt, null);
    }
});
