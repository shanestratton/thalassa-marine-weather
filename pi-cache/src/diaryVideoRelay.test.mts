import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DiaryVideoRelay } from './diaryVideoRelay.js';

const OWNER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
const CREDS = {
    url: 'https://project.supabase.co/functions/v1/diary-relay',
    relayId: 'r1',
    token: 'tok',
    ownerId: OWNER,
};

function makeRelay(
    fetchImpl: typeof fetch = (() => {
        throw new Error('no network in this test');
    }) as unknown as typeof fetch,
) {
    const dir = mkdtempSync(join(tmpdir(), 'video-relay-'));
    return { dir, relay: new DiaryVideoRelay(dir, () => CREDS, fetchImpl) };
}

function sha(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

const CLIP = Buffer.from('not really a video, but 40 bytes of bytes!!');
const PATH = `${OWNER}/1756600000000.mp4`;

test('a clip arrives in chunks, verifies, and parks', async () => {
    const { dir, relay } = makeRelay();
    const begun = await relay.begin({ operationId: 'op-1', path: PATH, totalBytes: CLIP.length, sha256: sha(CLIP) });
    assert.ok('id' in begun, JSON.stringify(begun));
    const id = (begun as { id: string }).id;

    assert.deepEqual(await relay.chunk(id, 0, CLIP.subarray(0, 16)), { ok: true });
    assert.deepEqual(await relay.chunk(id, 1, CLIP.subarray(16)), { ok: true });
    const finished = await relay.finish(id);
    assert.ok('ok' in finished, JSON.stringify(finished));

    assert.deepEqual(await relay.status('op-1'), { state: 'parked' });
    assert.deepEqual(await readFile(join(dir, 'diary-video-outbox', `${id}.bin`)), CLIP);
});

test('a resent chunk is success, a skipped chunk is refused', async () => {
    // Boat WiFi drops acks: the phone WILL resend a chunk the disk already
    // holds, and that must not corrupt the file or fail the transfer.
    const { relay } = makeRelay();
    const { id } = (await relay.begin({
        operationId: 'op-2',
        path: PATH,
        totalBytes: CLIP.length,
        sha256: sha(CLIP),
    })) as { id: string };
    await relay.chunk(id, 0, CLIP.subarray(0, 16));
    assert.deepEqual(await relay.chunk(id, 0, CLIP.subarray(0, 16)), { ok: true }); // retry: swallowed
    const skipped = await relay.chunk(id, 5, CLIP.subarray(16));
    assert.ok('error' in skipped);
});

test('a checksum mismatch discards the clip entirely', async () => {
    // Never upload bytes that are not what the phone said they were.
    const { relay } = makeRelay();
    const { id } = (await relay.begin({
        operationId: 'op-3',
        path: PATH,
        totalBytes: CLIP.length,
        sha256: 'ab'.repeat(32),
    })) as { id: string };
    await relay.chunk(id, 0, CLIP);
    const finished = await relay.finish(id);
    assert.ok('error' in finished && (finished as { status: number }).status === 422);
    assert.equal(await relay.status('op-3'), null);
});

test("a path outside the paired skipper's folder is refused", async () => {
    const { relay } = makeRelay();
    const result = await relay.begin({
        operationId: 'op-4',
        path: 'ffffffff-1111-2222-3333-444455556666/1756600000000.mp4',
        totalBytes: 10,
        sha256: 'ab'.repeat(32),
    });
    assert.ok('error' in result && (result as { status: number }).status === 403);
});

test('cancelling the diary operation kills the parked clip', async () => {
    const { relay } = makeRelay();
    const { id } = (await relay.begin({
        operationId: 'op-5',
        path: PATH,
        totalBytes: CLIP.length,
        sha256: sha(CLIP),
    })) as { id: string };
    await relay.chunk(id, 0, CLIP);
    await relay.finish(id);
    await relay.cancelOperation('op-5');
    assert.equal(await relay.status('op-5'), null);
});

test('the drain redeems a signed URL and uploads exactly the parked bytes', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body });
        if (String(url).includes('diary-relay')) {
            return new Response(
                JSON.stringify({
                    url: `https://project.supabase.co/storage/v1/object/upload/sign/diary-video/${PATH}?token=t`,
                }),
                { status: 200 },
            );
        }
        return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const { relay } = makeRelay(fetchImpl);
    const { id } = (await relay.begin({
        operationId: 'op-6',
        path: PATH,
        totalBytes: CLIP.length,
        sha256: sha(CLIP),
    })) as { id: string };
    await relay.chunk(id, 0, CLIP);
    await relay.finish(id);
    // finish() fires its own background drain; an explicit call can find the
    // lock held and return having done nothing. Production wants exactly that
    // (no double upload); the test polls for the outcome instead.
    for (let i = 0; i < 50 && (await relay.status('op-6'))?.state !== 'done'; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await relay.drainSoon();
    }

    assert.deepEqual(await relay.status('op-6'), { state: 'done' });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /diary-relay/);
    assert.equal(calls[1].method, 'PUT');
    assert.deepEqual(Buffer.from(calls[1].body as Uint8Array), CLIP);
});

test('a signed URL off the trusted origin is refused', async () => {
    // The Pi uploads to the skipper's own project and nowhere else — a
    // compromised or buggy relay answer must not exfiltrate the clip.
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes('diary-relay')) {
            return new Response(JSON.stringify({ url: 'https://evil.example.com/upload' }), { status: 200 });
        }
        throw new Error(`should never PUT, got ${init?.method} ${url}`);
    }) as unknown as typeof fetch;

    const { relay } = makeRelay(fetchImpl);
    const { id } = (await relay.begin({
        operationId: 'op-7',
        path: PATH,
        totalBytes: CLIP.length,
        sha256: sha(CLIP),
    })) as { id: string };
    await relay.chunk(id, 0, CLIP);
    await relay.finish(id);
    await relay.drainSoon();
    // Still parked: the grant was refused, the clip stays aboard for retry.
    assert.deepEqual((await relay.status('op-7'))?.state, 'parked');
});
