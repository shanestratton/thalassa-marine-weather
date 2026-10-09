/**
 * A paper filed on this phone uploads from its file (126-B3a, binder audit
 * DOC-2): the outbox carries a `local-vault://` path, never base64, and the
 * push reads the file through the WebView (no base64 read across the bridge),
 * uploads it to vessel_vault/<uid>/documents/<id>.<ext> with its own content
 * type, and pushes the row with the cloud reference.
 *
 * The REAL SyncService and the REAL supabase-js client, with only fetch faked
 * (in the style of SyncServicePinnedBearer.test.ts); the outbox is a small
 * fake; the vault files live in the in-memory filesystem. Fictional: account
 * 'user-1', boat 'Kestrel', test.invalid URLs, fake tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncQueueItem } from '../services/vessel/LocalDatabase';

function base64Url(value: unknown): string {
    return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const h = vi.hoisted(() => {
    const state = {
        storage: new Map<string, string>(),
        userToken: '',
        queue: [] as SyncQueueItem[],
        failed: [] as { id: string; error: string }[],
        uploads: [] as { path: string; contentType: string; bytes: Uint8Array }[],
        upserts: [] as { table: string; body: unknown }[],
        /** The next upload is refused with this HTTP status and body. */
        refuseUpload: null as null | { status: number; body: unknown },
    };

    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    /** A Blob's bytes, from jsdom's Blob (FileReader) or Node's (arrayBuffer). */
    async function bytesOfBlob(blob: Blob): Promise<Uint8Array> {
        if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
        });
    }

    async function bodyOf(init?: RequestInit): Promise<{ contentType: string; bytes: Uint8Array }> {
        const headers = new Headers(init?.headers);
        const body = init?.body as unknown;
        // The WebView sends a Blob as multipart (storage-js); a Blob from another
        // realm (Node's, in this test) goes as the raw body with its header.
        if (body instanceof FormData) {
            const part = body.get('') as Blob;
            return { contentType: part.type, bytes: await bytesOfBlob(part) };
        }
        const blob = body as Blob;
        return { contentType: headers.get('content-type') ?? '', bytes: await bytesOfBlob(blob) };
    }

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.pathname === '/auth/v1/user') {
            return json(200, {
                id: 'user-1',
                aud: 'authenticated',
                role: 'authenticated',
                app_metadata: {},
                user_metadata: {},
                created_at: '2026-01-01T00:00:00.000Z',
            });
        }
        if (url.pathname === '/rest/v1/rpc/get_sync_watermark') return json(200, new Date().toISOString());
        if (url.pathname.startsWith('/storage/v1/object/vessel_vault/') && method === 'POST') {
            if (state.refuseUpload) return json(state.refuseUpload.status, state.refuseUpload.body);
            const { contentType, bytes } = await bodyOf(init);
            const path = decodeURIComponent(url.pathname.slice('/storage/v1/object/vessel_vault/'.length));
            state.uploads.push({ path, contentType, bytes });
            return json(200, { Id: 'object-1', Key: `vessel_vault/${path}` });
        }
        if (url.pathname.startsWith('/rest/v1/')) {
            const table = url.pathname.slice('/rest/v1/'.length);
            if (method === 'POST') {
                state.upserts.push({ table, body: JSON.parse(String(init?.body)) });
                return json(201, []);
            }
            return json(200, []);
        }
        return json(404, { message: `unexpected ${url.pathname}` });
    });

    return { state, fetch };
});

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
        isPluginAvailable: () => false,
        convertFileSrc: (uri: string) => uri.replace('file://', 'capacitor://localhost/_capacitor_file_'),
    },
    registerPlugin: vi.fn(() => ({})),
}));

vi.mock('../services/supabase', async () => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    return {
        supabase: createClient('https://test-project.test.invalid', 'anon-test-key', {
            auth: {
                persistSession: true,
                autoRefreshToken: false,
                detectSessionInUrl: false,
                storageKey: 'test-auth',
                storage: {
                    getItem: async (key: string) => h.state.storage.get(key) ?? null,
                    setItem: async (key: string, value: string) => {
                        h.state.storage.set(key, value);
                    },
                    removeItem: async (key: string) => {
                        h.state.storage.delete(key);
                    },
                },
            },
            global: { fetch: h.fetch as unknown as typeof fetch },
        }),
    };
});

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));

vi.mock('../services/vessel/sharedBinders', async () => {
    const actual = await vi.importActual<typeof import('../services/vessel/sharedBinders')>(
        '../services/vessel/sharedBinders',
    );
    return {
        refreshSharedBinders: vi.fn(async () => ({ changed: false, fresh: true })),
        binderWriteGranted: () => true,
        anySkipperGrantsWrite: () => false,
        TABLE_REGISTER: actual.TABLE_REGISTER,
        binderRegisterForRow: actual.binderRegisterForRow,
        isGalleyShareLive: () => false,
    };
});

vi.mock('../services/vessel/LocalDatabase', () => ({
    getFullQueue: () => h.state.queue.map((item) => ({ ...item })),
    markSyncing: vi.fn(async (ids: string[]) => {
        h.state.queue = h.state.queue.map((item) => (ids.includes(item.id) ? { ...item, status: 'syncing' } : item));
    }),
    removeSynced: vi.fn(async (ids: string[]) => {
        h.state.queue = h.state.queue.filter((item) => !ids.includes(item.id));
    }),
    markFailed: vi.fn(async (ids: string[], error: string) => {
        for (const id of ids) h.state.failed.push({ id, error });
        h.state.queue = h.state.queue.map((item) =>
            ids.includes(item.id) ? { ...item, status: 'failed', error_message: error } : item,
        );
    }),
    retryFailed: vi.fn(async () => undefined),
    getSyncMeta: () => ({
        lastPullTimestamp: '2026-10-09T00:00:00.000Z',
        lastFullPullTimestamp: '2026-10-09T00:00:00.000Z',
        lastPushTimestamp: null,
        deviceId: 'test-device',
        ownerUserId: 'user-1',
    }),
    updateSyncMeta: vi.fn(async () => undefined),
    mergePulledRecords: vi.fn(async (_table: string, rows: unknown[]) => rows.length),
    prunePulledTable: vi.fn(async () => 0),
    getLocalDatabaseSession: () => ({ identity: 'user-1', generation: 1 }),
    isLocalDatabaseSessionCurrent: () => true,
    getById: () => null,
    bulkDelete: vi.fn(async () => undefined),
    rewriteQueuedInsert: vi.fn(async () => null),
    onOutboxAppended: () => () => undefined,
}));

import { memoryFs } from './helpers/memoryFilesystem';

const MiB = 1024 * 1024;
const VAULT = 'vault/user_757365722d31/documents';

function storeSession(): void {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    h.state.userToken = [
        base64Url({ alg: 'HS256', typ: 'JWT' }),
        base64Url({ sub: 'user-1', role: 'authenticated', aud: 'authenticated', exp: expiresAt }),
        'test-signature',
    ].join('.');
    h.state.storage.set(
        'test-auth',
        JSON.stringify({
            access_token: h.state.userToken,
            refresh_token: 'refresh-test-token',
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: expiresAt,
            user: { id: 'user-1', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} },
        }),
    );
}

function bytesOf(size: number, head: string | number[]): Uint8Array {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 13 + 5) % 253;
    bytes.set(typeof head === 'string' ? Array.from(head, (c) => c.charCodeAt(0)) : head, 0);
    return bytes;
}

/** A file this phone picked, already in the vault. */
function plant(name: string, bytes: Uint8Array): string {
    memoryFs.files.set(`LIBRARY/${VAULT}/${name}`, { data: Buffer.from(bytes).toString('base64'), mtime: Date.now() });
    return `local-vault://${VAULT}/${name}`;
}

function queueInsert(id: string, name: string, fileUri: string): void {
    h.state.queue.push({
        id: `queue-${id}`,
        table_name: 'ship_documents',
        record_id: id,
        mutation_type: 'INSERT',
        payload: JSON.stringify({
            id,
            user_id: 'user-1',
            document_name: name,
            category: 'Registration',
            issue_date: null,
            expiry_date: null,
            file_uri: fileUri,
            notes: null,
        }),
        created_at: '2026-10-09T01:00:00.000Z',
        status: 'pending',
        retry_count: 0,
        owner_user_id: 'user-1',
    });
}

let sync: typeof import('../services/vessel/SyncService');

beforeEach(async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    memoryFs.reset();
    h.state.storage.clear();
    h.state.queue = [];
    h.state.failed = [];
    h.state.uploads = [];
    h.state.upserts = [];
    h.state.refuseUpload = null;
    storeSession();
    // The WebView serves convertFileSrc URLs from the app's own files.
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
            const file = memoryFs.fileForUri(String(input));
            if (!file) return new Response('not found', { status: 404 });
            return new Response(Buffer.from(file.data, 'base64'), { status: 200 });
        }),
    );
    sync = await import('../services/vessel/SyncService');
});

afterEach(() => {
    sync.stopSyncEngine();
    vi.unstubAllGlobals();
});

describe('a paper filed on this phone uploads from its file', () => {
    it('uploads the exact bytes as application/pdf, pushes the cloud reference, and empties the outbox', async () => {
        const id = '7f3e2d1c-0000-4000-8000-0000000000a1';
        const bytes = bytesOf(2 * MiB + 3, '%PDF-1.7\n');
        queueInsert(id, 'Registo de Propriedade', plant('p-registo.pdf', bytes));

        const result = await sync.syncNow();

        expect(result.errors).toEqual([]);
        expect(h.state.uploads).toHaveLength(1);
        const [upload] = h.state.uploads;
        expect(upload.path).toBe(`user-1/documents/${id}.pdf`);
        expect(upload.contentType).toBe('application/pdf');
        expect(Buffer.from(upload.bytes).equals(Buffer.from(bytes))).toBe(true);
        const pushed = h.state.upserts.find((entry) => entry.table === 'ship_documents')?.body as {
            file_uri: string;
        };
        expect(pushed.file_uri).toBe(`supabase-storage://vessel_vault/user-1/documents/${id}.pdf`);
        expect(h.state.queue).toEqual([]);
        // Nothing read the file as base64 across the bridge (only the small index is read as text).
        expect(memoryFs.calls.some((call) => call.op === 'readFile' && call.path.includes('/documents/'))).toBe(false);
    });

    it("notes on this phone's index where its own copy went", async () => {
        const id = '2b3c4d5e-0000-4000-8000-0000000000a5';
        const uri = plant('p-registo.pdf', bytesOf(MiB, '%PDF-1.7\n'));
        memoryFs.files.set(`LIBRARY/vault/user_757365722d31/index.json`, {
            data: JSON.stringify({
                version: 1,
                entries: { [id]: { path: `${VAULT}/p-registo.pdf`, bytes: MiB, savedAt: '2026-10-09T01:00:00.000Z' } },
            }),
            mtime: Date.now(),
            encoding: 'utf8',
        });
        queueInsert(id, 'Registo de Propriedade', uri);

        await sync.syncNow();

        const index = JSON.parse(memoryFs.files.get('LIBRARY/vault/user_757365722d31/index.json')!.data) as {
            entries: Record<string, { remote?: string; pushedAt?: string }>;
        };
        expect(index.entries[id].remote).toBe(`supabase-storage://vessel_vault/user-1/documents/${id}.pdf`);
        expect(index.entries[id].pushedAt).toEqual(expect.any(String));
    });

    it('a HEIC photo goes up as image/heic', async () => {
        const id = '5e6f7a8b-0000-4000-8000-0000000000a2';
        const heic = [0, 0, 0, 0x18, ...Array.from('ftypheic', (c) => c.charCodeAt(0))];
        queueInsert(id, 'Πιστοποιητικό νηολόγησης', plant('p-cert.heic', bytesOf(MiB, heic)));

        await sync.syncNow();

        expect(h.state.uploads.map((upload) => [upload.path, upload.contentType])).toEqual([
            [`user-1/documents/${id}.heic`, 'image/heic'],
        ]);
    });

    it('a missing file fails the item with "Local attachment missing", and pushes no row', async () => {
        const id = '9c0d1e2f-0000-4000-8000-0000000000a3';
        queueInsert(id, 'Passport — Søren Holm', `local-vault://${VAULT}/p-gone.pdf`);

        await sync.syncNow();

        expect(h.state.failed).toEqual([{ id: `queue-${id}`, error: 'Local attachment missing' }]);
        expect(h.state.uploads).toEqual([]);
        expect(h.state.upserts.filter((entry) => entry.table === 'ship_documents')).toEqual([]);
    });

    it("a 413 from Storage fails the item with Storage's own message", async () => {
        const id = '1a2b3c4d-0000-4000-8000-0000000000a4';
        queueInsert(id, 'Ship radio licence', plant('p-radio.pdf', bytesOf(MiB, '%PDF-1.4\n')));
        h.state.refuseUpload = {
            status: 413,
            body: {
                statusCode: '413',
                error: 'Payload too large',
                message: 'The object exceeded the maximum allowed size',
            },
        };

        await sync.syncNow();

        expect(h.state.failed).toHaveLength(1);
        expect(h.state.failed[0].error).toContain('The object exceeded the maximum allowed size');
        expect(h.state.upserts.filter((entry) => entry.table === 'ship_documents')).toEqual([]);
    });
});
