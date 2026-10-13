/**
 * The chart vault's memory (127-C-d decision 7): a byte-bounded LRU of
 * Buffers, one decode at a time with single-flight, a phone's request ahead
 * of prewarm ahead of indexing, a bounded queue that answers vault-busy, and
 * a hash check on every decode. Fictional cells; the decoder is a stub.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ChartVault, VaultRefusal, type VaultEntryLike } from './chartVault.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function bytesFor(cellId: string, size = 250, salt = ''): Buffer {
    const out = Buffer.alloc(size, 0x20);
    out.write(`{"cells":[{"cellId":"${cellId}${salt}"}]}`);
    return out;
}

function harness(options: { lruBytes?: number; queueMax?: number; size?: number } = {}) {
    const index = new Map<string, VaultEntryLike>();
    const order: string[] = [];
    const decodes = new Map<string, number>();
    let gate: Promise<void> | null = null;
    let release = () => {};
    const salts = new Map<string, string>();
    const add = (cellId: string) => {
        const bytes = bytesFor(cellId, options.size);
        index.set(cellId, { cellId, contentSha256: sha(bytes) });
    };
    const vault = new ChartVault({
        lruBytes: options.lruBytes ?? 600,
        queueMax: options.queueMax ?? 64,
        retryAfterSeconds: 7,
        lookup: (cellId) => index.get(cellId),
        decode: async (entry) => {
            order.push(entry.cellId);
            decodes.set(entry.cellId, (decodes.get(entry.cellId) ?? 0) + 1);
            if (gate) await gate;
            const bytes = bytesFor(entry.cellId, options.size, salts.get(entry.cellId) ?? '');
            return { bytes, sha256: sha(bytes) };
        },
        reindex: async (entry, decoded) => {
            const next = { ...entry, contentSha256: decoded.sha256 };
            index.set(entry.cellId, next);
            return next;
        },
    });
    return {
        vault,
        index,
        order,
        decodes,
        add,
        hold() {
            gate = new Promise<void>((resolve) => {
                release = () => {
                    gate = null;
                    resolve();
                };
            });
        },
        release: () => release(),
        salt: (cellId: string, value: string) => salts.set(cellId, value),
    };
}

test('the LRU is bounded by Buffer bytes: a 600-byte cap holds two 250-byte cells, never three', async () => {
    const h = harness();
    for (const id of ['ZZ5KESTA', 'ZZ5KESTB', 'ZZ5KESTC']) h.add(id);
    for (const id of ['ZZ5KESTA', 'ZZ5KESTB', 'ZZ5KESTC']) await h.vault.get(id);
    assert.equal(h.vault.lruCells, 2);
    assert.equal(h.vault.lruBytes, 500);
    assert.equal(h.vault.cached('ZZ5KESTA'), false, 'the least recently used went first');
    assert.equal(h.vault.cached('ZZ5KESTB'), true);
    assert.equal(h.vault.cached('ZZ5KESTC'), true);
    const got = await h.vault.get('ZZ5KESTC');
    assert.ok(Buffer.isBuffer(got.bytes), 'the cache holds Buffers, not strings');
});

test('eviction goes least recently USED first, not least recently added', async () => {
    const h = harness();
    for (const id of ['ZZ5KESTA', 'ZZ5KESTB', 'ZZ5KESTC']) h.add(id);
    await h.vault.get('ZZ5KESTA');
    await h.vault.get('ZZ5KESTB');
    await h.vault.get('ZZ5KESTA'); // a hit: A is now the most recent
    await h.vault.get('ZZ5KESTC');
    assert.equal(h.vault.cached('ZZ5KESTA'), true);
    assert.equal(h.vault.cached('ZZ5KESTB'), false);
    assert.equal(h.vault.cached('ZZ5KESTC'), true);
    assert.equal(h.decodes.get('ZZ5KESTA'), 1, 'the hit decoded nothing');
});

test('a cell larger than the whole cache is served but never cached', async () => {
    const h = harness({ lruBytes: 600, size: 700 });
    h.add('ZZ5KESTA');
    const got = await h.vault.get('ZZ5KESTA');
    assert.equal(got.bytes.length, 700);
    assert.equal(h.vault.lruBytes, 0);
});

test('single-flight: three concurrent requests for one cell make one decode', async () => {
    const h = harness();
    h.add('ZZ5KESTA');
    h.hold();
    const three = [h.vault.get('ZZ5KESTA'), h.vault.get('ZZ5KESTA'), h.vault.get('ZZ5KESTA')];
    await new Promise((resolve) => setImmediate(resolve));
    h.release();
    const results = await Promise.all(three);
    assert.equal(h.decodes.get('ZZ5KESTA'), 1);
    assert.ok(results.every((r) => r.sha256 === results[0].sha256));
});

test('order: a phone request jumps ahead of queued prewarm, and prewarm ahead of indexing', async () => {
    const h = harness({ lruBytes: 10_000 });
    for (const id of ['ZZ5KESTA', 'ZZ5PREW1', 'ZZ5PREW2', 'ZZ5PHONE']) h.add(id);
    h.hold();
    const running = h.vault.get('ZZ5KESTA');
    await new Promise((resolve) => setImmediate(resolve));
    const indexed = h.vault.runIndex(async () => {
        h.order.push('index-task');
    });
    const p1 = h.vault.prewarm('ZZ5PREW1');
    const p2 = h.vault.prewarm('ZZ5PREW2');
    const phone = h.vault.get('ZZ5PHONE');
    h.release();
    await Promise.all([running, indexed, p1, p2, phone]);
    assert.deepEqual(h.order, ['ZZ5KESTA', 'ZZ5PHONE', 'ZZ5PREW1', 'ZZ5PREW2', 'index-task']);
});

test('over 64 queued, a request answers vault-busy with a Retry-After', async () => {
    const h = harness({ lruBytes: 1_000_000, queueMax: 64 });
    h.add('ZZ5KESTA');
    for (let i = 0; i < 65; i++) h.add(`ZZ5Q${String(i).padStart(4, '0')}`);
    h.hold();
    const running = h.vault.get('ZZ5KESTA');
    await new Promise((resolve) => setImmediate(resolve));
    const queued = Array.from({ length: 64 }, (_, i) => h.vault.get(`ZZ5Q${String(i).padStart(4, '0')}`));
    await assert.rejects(h.vault.get('ZZ5Q0064'), (error: unknown) => {
        assert.ok(error instanceof VaultRefusal);
        assert.equal(error.code, 'vault-busy');
        assert.equal(error.status, 503);
        assert.equal(error.retryAfterSeconds, 7);
        return true;
    });
    // Prewarm never queues past the cap either: it is skipped, not refused.
    assert.equal(await h.vault.prewarm('ZZ5Q0064'), false);
    h.release();
    await Promise.all([running, ...queued]);
});

test('a decode whose hash differs from the index re-indexes that cell and serves the new hash', async () => {
    const h = harness();
    h.add('ZZ5KESTA');
    const indexed = h.index.get('ZZ5KESTA')!.contentSha256;
    h.salt('ZZ5KESTA', '-reissued');
    const got = await h.vault.get('ZZ5KESTA');
    assert.notEqual(got.sha256, indexed);
    assert.equal(h.index.get('ZZ5KESTA')!.contentSha256, got.sha256, 'the index carries the new hash');
    assert.equal(sha(got.bytes), got.sha256);
    // Cached under the new revision: the next request decodes nothing.
    await h.vault.get('ZZ5KESTA');
    assert.equal(h.decodes.get('ZZ5KESTA'), 1);
});

test('a cell the index does not hold is cell-not-found, and evict drops a cached cell', async () => {
    const h = harness();
    await assert.rejects(h.vault.get('ZZ5NONE0'), (error: unknown) => {
        assert.ok(error instanceof VaultRefusal);
        assert.equal(error.code, 'cell-not-found');
        assert.equal(error.status, 404);
        return true;
    });
    h.add('ZZ5KESTA');
    await h.vault.get('ZZ5KESTA');
    h.vault.evict('ZZ5KESTA');
    assert.equal(h.vault.cached('ZZ5KESTA'), false);
    assert.equal(h.vault.lruBytes, 0);
});
