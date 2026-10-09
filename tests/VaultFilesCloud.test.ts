/**
 * Ship's papers filed on another device are kept on this phone (126-B3b,
 * binder audit DOC-1): the cloud's file is downloaded natively into the vault
 * the first time it is opened with signal, or ahead of time over Wi-Fi, and
 * never through JS (the 2 GB WebContent ceiling). A copy is used as it is
 * while its row has not changed; a newer row costs one look at the stored
 * object, and a download only when the object itself changed. The Wi-Fi pass
 * is budgeted (the boat's Wi-Fi is a satellite link): no Manuals, nothing over
 * 25 MiB, 150 MiB a pass, one file at a time, never across an account change,
 * at most once in 30 minutes after a sync. Copies of papers that are gone are
 * collected an hour on, with their index entries.
 *
 * The real vaultFiles and LocalDatabase over the in-memory filesystem, whose
 * downloadFile stands in for the native download; the real supabase-js client
 * with only fetch faked, answering sign and list as Storage does. Fictional
 * papers on the fictional 'Kestrel' (skipper 'kestrel-skipper') and
 * 'Albatross' (crew 'albatross-crew'); test.invalid URLs, fake tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryFilesystem } from './helpers/memoryFilesystem';
import type { ShipDocument } from '../types';

interface StoredObject {
    bytes: Uint8Array;
    eTag: string;
    updatedAt: string;
    /** What Storage lists as the object's size, when the test claims more than its bytes. */
    size?: number;
    /** The content type Storage lists, when not the one its path implies. */
    type?: string;
}

const h = vi.hoisted(() => {
    const state = {
        objects: new Map<string, StoredObject>(),
        offline: false,
        requests: [] as { method: string; url: string; body?: Record<string, unknown> }[],
        network: { connected: true, connectionType: 'wifi' },
        warn: null as ((...args: unknown[]) => void) | null,
    };
    const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        state.requests.push({ method, url: url.href, body });
        if (state.offline) throw new TypeError('Failed to fetch');
        if (url.pathname === '/storage/v1/object/list/vessel_vault' && method === 'POST') {
            const folder = `${String(body?.prefix ?? '').replace(/\/$/, '')}/`;
            const search = String(body?.search ?? '').toLowerCase();
            const listed = [...state.objects]
                .filter(([path]) => {
                    const rest = path.slice(folder.length);
                    return path.startsWith(folder) && !rest.includes('/') && rest.toLowerCase().startsWith(search);
                })
                .map(([path, object]) => ({
                    name: path.slice(folder.length),
                    id: `object-${path}`,
                    updated_at: object.updatedAt,
                    created_at: object.updatedAt,
                    last_accessed_at: object.updatedAt,
                    metadata: {
                        eTag: object.eTag,
                        size: object.size ?? object.bytes.length,
                        mimetype: object.type ?? (path.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf'),
                    },
                }));
            return json(200, listed);
        }
        if (url.pathname.startsWith('/storage/v1/object/sign/vessel_vault/') && method === 'POST') {
            const path = decodeURIComponent(url.pathname.slice('/storage/v1/object/sign/vessel_vault/'.length));
            if (!state.objects.has(path))
                return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
            return json(200, { signedURL: `/object/sign/vessel_vault/${path}?token=fixture.signed.token` });
        }
        return json(404, { message: `unexpected ${url.pathname}` });
    });

    return { state, fetch };
});

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        isPluginAvailable: () => true,
        convertFileSrc: (uri: string) => uri.replace('file://', 'capacitor://localhost/_capacitor_file_'),
    },
    registerPlugin: vi.fn(() => ({})),
}));
vi.mock('@capacitor/network', () => ({ Network: { getStatus: vi.fn(async () => ({ ...h.state.network })) } }));
vi.mock('../services/supabase', async () => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    return {
        supabase: createClient('https://kestrel-project.test.invalid', 'anon-test-key', {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: { fetch: h.fetch as unknown as typeof fetch },
        }),
    };
});
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: (...args: unknown[]) => h.state.warn?.(...args),
        error: vi.fn(),
    }),
}));

type Vault = typeof import('../services/vessel/vaultFiles');
type Database = typeof import('../services/vessel/LocalDatabase');

const MiB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const SKIPPER = 'kestrel-skipper';
const CREW = 'albatross-crew';
const AT = '2026-10-09T01:00:00.000Z';

const REGISTO = '1a2b3c4d-0000-4000-8000-0000000000d1';
const GREEK = '2b3c4d5e-0000-4000-8000-0000000000d2';
const JAPANESE = '3c4d5e6f-0000-4000-8000-0000000000d3';
const RADIO = '4d5e6f7a-0000-4000-8000-0000000000d4';
const MANUAL = '5e6f7a8b-0000-4000-8000-0000000000d5';

let mem: MemoryFilesystem;
let vault: Vault;
let db: Database;

async function load(identity: string | null = SKIPPER): Promise<void> {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    mem = (await import('@capacitor/filesystem')).Filesystem as unknown as MemoryFilesystem;
    mem.reset();
    db = await import('../services/vessel/LocalDatabase');
    await db.initLocalDatabase(identity);
    vault = await import('../services/vessel/vaultFiles');
}

const token = (identity: string | null = SKIPPER) => db.identityFileToken(identity);
const docsDir = (identity: string | null = SKIPPER) => `vault/${token(identity)}/documents/`;
const vaultKeys = (identity: string | null = SKIPPER) =>
    [...mem.files.keys()].filter((key) => key.startsWith(`LIBRARY/${docsDir(identity)}`));
const indexOf = (identity: string | null = SKIPPER) =>
    (
        JSON.parse(mem.files.get(`LIBRARY/vault/${token(identity)}/index.json`)?.data ?? '{"entries":{}}') as {
            entries: Record<
                string,
                {
                    path: string;
                    bytes: number;
                    remote?: string;
                    rowStamp?: string;
                    objectStamp?: string;
                    savedAt: string;
                }
            >;
        }
    ).entries;

function bytesOf(size: number, text: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 13 + 5) % 251;
    bytes.set(
        Array.from(text, (c) => c.charCodeAt(0)),
        0,
    );
    return bytes;
}

function paper(
    id: string,
    name: string,
    category: ShipDocument['category'],
    ext: string,
    updatedAt = AT,
    owner = SKIPPER,
): ShipDocument {
    return {
        id,
        user_id: owner,
        document_name: name,
        category,
        issue_date: null,
        expiry_date: null,
        file_uri: `supabase-storage://vessel_vault/${owner}/documents/${id}.${ext}`,
        notes: 'Cleared in at Horta',
        created_at: AT,
        updated_at: updatedAt,
    };
}

/** The file another device uploaded, as Storage holds it. */
function store(doc: ShipDocument, text: string, options: { eTag?: string; size?: number; bytes?: number } = {}) {
    const path = doc.file_uri!.slice('supabase-storage://vessel_vault/'.length);
    h.state.objects.set(path, {
        bytes: bytesOf(options.bytes ?? 4096, text),
        eTag: options.eTag ?? `"etag-${text.length}-${path.length}"`,
        updatedAt: doc.updated_at,
        size: options.size,
    });
    return path;
}

const row = (id: string) => db.getById<ShipDocument>('ship_documents', id)!;
const lists = () => h.state.requests.filter((r) => r.url.includes('/object/list/')).length;
const downloads = () => mem.calls.filter((c) => c.op === 'downloadFile').length;
const fileText = (key: string) => Buffer.from(mem.files.get(key)!.data, 'base64').toString('latin1');

beforeEach(async () => {
    h.state.objects.clear();
    h.state.requests.length = 0;
    h.state.offline = false;
    h.state.network = { connected: true, connectionType: 'wifi' };
    h.state.warn = vi.fn();
    h.fetch.mockClear();
    await load();
    // The native download: the signed URL's object, straight into the file.
    mem.serve = (url: string) => {
        if (h.state.offline) return 503;
        const marker = '/storage/v1/object/sign/vessel_vault/';
        const { pathname } = new URL(url);
        const object = h.state.objects.get(
            decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length)),
        );
        return object ? object.bytes : 404;
    };
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('cacheCloudFile', () => {
    it('downloads natively into Library/vault/<identity>/documents/c-<id>.pdf and indexes it', async () => {
        const doc = paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf');
        store(doc, '%PDF-1.7 Registo de Propriedade');
        await db.mergePulledRecords('ship_documents', [doc]);
        // JS's own fetch never sees the file: only supabase-js's sign and list go out.
        const pageFetch = vi.fn();
        vi.stubGlobal('fetch', pageFetch);

        const kept = await vault.cacheCloudFile(row(REGISTO));

        const path = `${docsDir()}c-${REGISTO}.pdf`;
        expect(kept).toMatchObject({ downloaded: true, copy: { path, ext: 'pdf', fresh: true } });
        expect(mem.calls.filter((c) => c.op === 'downloadFile')).toEqual([
            { op: 'downloadFile', path, directory: 'LIBRARY' },
        ]);
        expect(fileText(`LIBRARY/${path}`).startsWith('%PDF-1.7 Registo de Propriedade')).toBe(true);
        expect(pageFetch).not.toHaveBeenCalled();
        // No request ever reads the signed URL's bytes into JS.
        expect(h.state.requests.every((r) => r.method === 'POST' && !r.url.includes('token='))).toBe(true);
        expect(indexOf()[REGISTO]).toMatchObject({
            path,
            remote: doc.file_uri,
            rowStamp: AT,
            objectStamp: expect.stringContaining('etag-'),
        });
        // From now on it opens with no signal, and its card says so.
        expect(await vault.localCopyFor(row(REGISTO))).toMatchObject({ path, fresh: true });
        expect(await vault.paperFileStates([row(REGISTO)])).toEqual({ [REGISTO]: 'local' });
    });

    it('a photo keeps its own type: the extension comes from the stored path, never the signed URL', async () => {
        const doc = paper(GREEK, 'Πιστοποιητικό νηολόγησης', 'Registration', 'jpg');
        store(doc, '\xff\xd8\xff\xe0 Πιστοποιητικό');
        await db.mergePulledRecords('ship_documents', [doc]);

        const kept = await vault.cacheCloudFile(row(GREEK));

        expect(kept.copy).toMatchObject({ path: `${docsDir()}c-${GREEK}.jpg`, ext: 'jpg' });
    });

    it('a row that is newer, over the same stored object, costs one look and no download', async () => {
        const doc = paper(JAPANESE, '船舶検査証書', 'Registration', 'pdf');
        store(doc, '%PDF-1.7 船舶検査証書');
        await db.mergePulledRecords('ship_documents', [doc]);
        await vault.cacheCloudFile(row(JAPANESE));

        // A notes edit on the iPad bumps the row, not the file.
        const later = '2026-10-10T08:30:00.000Z';
        await db.mergePulledRecords('ship_documents', [{ ...doc, notes: 'Renewed in Lyttelton', updated_at: later }]);
        // Until it is checked, a copy that may be older is used only with no signal.
        expect(await vault.localCopyFor(row(JAPANESE))).toMatchObject({ fresh: false });
        const listsBefore = lists();

        const kept = await vault.cacheCloudFile(row(JAPANESE));

        expect(kept).toMatchObject({ downloaded: false, copy: { fresh: true } });
        expect(lists()).toBe(listsBefore + 1);
        expect(downloads()).toBe(1);
        expect(indexOf()[JAPANESE].rowStamp).toBe(later);

        // Confirmed: the next open makes no request at all.
        const requests = h.state.requests.length;
        await vault.cacheCloudFile(row(JAPANESE));
        expect(h.state.requests.length).toBe(requests);
    });

    it('a stored object that changed is downloaded again', async () => {
        const doc = paper(RADIO, 'Ship radio licence', 'Radio/MMSI', 'pdf');
        store(doc, '%PDF-1.7 licence 2025', { eTag: '"etag-2025"' });
        await db.mergePulledRecords('ship_documents', [doc]);
        await vault.cacheCloudFile(row(RADIO));

        // The renewed licence, filed on the iPad over the same path.
        const later = '2026-10-11T02:00:00.000Z';
        store({ ...doc, updated_at: later }, '%PDF-1.7 licence 2026', { eTag: '"etag-2026"' });
        await db.mergePulledRecords('ship_documents', [{ ...doc, updated_at: later }]);

        const kept = await vault.cacheCloudFile(row(RADIO));

        expect(kept.downloaded).toBe(true);
        expect(downloads()).toBe(2);
        expect(fileText(`LIBRARY/${docsDir()}c-${RADIO}.pdf`).startsWith('%PDF-1.7 licence 2026')).toBe(true);
        expect(indexOf()[RADIO]).toMatchObject({ objectStamp: '"etag-2026"', rowStamp: later });
    });

    it('with no signal, the copy there is opens and nothing goes out', async () => {
        const doc = paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf');
        store(doc, '%PDF-1.7 Registo de Propriedade');
        await db.mergePulledRecords('ship_documents', [doc]);
        await vault.cacheCloudFile(row(REGISTO));
        h.state.offline = true;
        const requests = h.state.requests.length;

        // Confirmed for this row: kept without a request.
        expect((await vault.cacheCloudFile(row(REGISTO))).copy).toMatchObject({ fresh: true });
        // A newer row arrived before the signal went: still the best copy there is.
        await db.mergePulledRecords('ship_documents', [{ ...doc, updated_at: '2026-10-12T00:00:00.000Z' }]);
        expect(await vault.localCopyFor(row(REGISTO))).toMatchObject({ path: `${docsDir()}c-${REGISTO}.pdf` });

        expect(h.state.requests.length).toBe(requests);
        expect(downloads()).toBe(1);
    });

    it('a copy this phone filed and pushed is confirmed by one look, never downloaded again', async () => {
        const picked = await vault.saveAttachment(
            new File([bytesOf(8192, '%PDF-1.7 Registo')], 'Registo de Propriedade.pdf', { type: 'application/pdf' }),
        );
        if (!picked.ok) throw new Error('not saved');
        await db.insertLocal('ship_documents', {
            ...paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf'),
            file_uri: picked.uri,
        });
        await vault.recordLocalCopy(REGISTO, picked.uri, picked.bytes);
        // The push uploads it to the same path; Storage now holds these very bytes.
        const doc = paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf', '2026-10-09T03:00:00.000Z');
        h.state.objects.set(`${SKIPPER}/documents/${REGISTO}.pdf`, {
            bytes: bytesOf(8192, '%PDF-1.7 Registo'),
            eTag: '"etag-pushed"',
            updatedAt: doc.updated_at,
        });
        await vault.notePushedCopy(REGISTO, picked.uri, doc.file_uri!);
        await db.removeSynced(db.getFullQueue().map((item) => item.id));
        await db.mergePulledRecords('ship_documents', [doc]);

        const kept = await vault.cacheCloudFile(row(REGISTO));

        expect(kept).toMatchObject({ downloaded: false, copy: { path: picked.uri.slice('local-vault://'.length) } });
        expect(downloads()).toBe(0);
        expect(indexOf()[REGISTO]).toMatchObject({ objectStamp: '"etag-pushed"', rowStamp: doc.updated_at });
    });

    it('an object Storage does not have is an error, and nothing is kept', async () => {
        await db.mergePulledRecords('ship_documents', [paper(RADIO, 'Ship radio licence', 'Radio/MMSI', 'pdf')]);

        await expect(vault.cacheCloudFile(row(RADIO))).rejects.toThrow();

        expect(vaultKeys()).toEqual([]);
        expect(indexOf()[RADIO]).toBeUndefined();
    });
});

describe('prefetchPapers', () => {
    /** The ship's papers on the iPad: four papers and a 40 MB manual. */
    async function fileOnTheIpad() {
        const docs = [
            paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf', '2026-10-09T05:00:00.000Z'),
            paper(GREEK, 'Πιστοποιητικό νηολόγησης', 'Insurance', 'jpg', '2026-10-09T04:00:00.000Z'),
            paper(JAPANESE, '船舶検査証書', 'Customs Clearances', 'pdf', '2026-10-09T03:00:00.000Z'),
            paper(RADIO, 'Ship radio licence', 'Radio/MMSI', 'pdf', '2026-10-09T02:00:00.000Z'),
            paper(MANUAL, 'Watermaker manual', 'User Manuals', 'pdf', '2026-10-09T06:00:00.000Z'),
        ];
        for (const doc of docs)
            store(doc, `%PDF-1.7 ${doc.document_name}`, doc.id === MANUAL ? { size: 40_000_000 } : {});
        await db.mergePulledRecords('ship_documents', docs);
        return docs;
    }
    const downloaded = () =>
        mem.calls.filter((c) => c.op === 'downloadFile').map((c) => c.path.split('/').pop()!.slice(2, 10));

    it('on Wi-Fi keeps every paper but the manual, newest first; on cellular downloads nothing', async () => {
        await fileOnTheIpad();
        h.state.network = { connected: true, connectionType: 'cellular' };

        expect(await vault.prefetchPapers()).toBe(0);
        expect(downloads()).toBe(0);
        expect(lists()).toBe(0);

        h.state.network = { connected: true, connectionType: 'wifi' };
        expect(await vault.prefetchPapers()).toBe(4);

        expect(downloaded()).toEqual(['1a2b3c4d', '2b3c4d5e', '3c4d5e6f', '4d5e6f7a']);
        // Manuals keep for an open with signal: never even looked up.
        expect(h.state.requests.some((r) => JSON.stringify(r.body ?? {}).includes(MANUAL))).toBe(false);
        expect(await vault.paperFileStates(db.getAll<ShipDocument>('ship_documents'))).toEqual({
            [REGISTO]: 'local',
            [GREEK]: 'local',
            [JAPANESE]: 'local',
            [RADIO]: 'local',
            [MANUAL]: 'cloud',
        });

        // A second pass finds them all current, with no request at all.
        const requests = h.state.requests.length;
        expect(await vault.prefetchPapers()).toBe(0);
        expect(h.state.requests.length).toBe(requests);
    });

    it('skips a paper over 25 MiB, which stays "Needs signal to open"', async () => {
        const survey = paper(RADIO, 'Hull survey, Papeete', 'Insurance', 'pdf', '2026-10-09T07:00:00.000Z');
        store(survey, '%PDF-1.7 survey', { size: 30 * MiB });
        const registo = paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf');
        store(registo, '%PDF-1.7 Registo');
        await db.mergePulledRecords('ship_documents', [survey, registo]);

        expect(await vault.prefetchPapers()).toBe(1);

        expect(downloaded()).toEqual(['1a2b3c4d']);
        expect(await vault.paperFileStates([row(RADIO)])).toEqual({ [RADIO]: 'cloud' });
    });

    it('stops at 150 MiB a pass', async () => {
        const docs = Array.from({ length: 8 }, (_, i) =>
            paper(
                `${i}a0b0c0d-0000-4000-8000-0000000000e${i}`,
                `Crew list ${i + 1}`,
                'Customs Clearances',
                'pdf',
                `2026-10-09T0${i}:00:00.000Z`,
            ),
        );
        // 24 MiB each as Storage lists them (the bytes kept small here).
        for (const doc of docs) store(doc, '%PDF-1.7 crew list', { size: 24 * MiB });
        await db.mergePulledRecords('ship_documents', docs);

        expect(await vault.prefetchPapers()).toBe(6);

        // Six of 24 MiB is 144 MiB; a seventh would pass 150.
        expect(downloads()).toBe(6);
    });

    it('downloads one file at a time, and an ask during a pass gets one more pass after it', async () => {
        await fileOnTheIpad();
        let inFlight = 0;
        let most = 0;
        const serve = mem.serve;
        mem.serve = async (url) => {
            inFlight += 1;
            most = Math.max(most, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return serve(url);
        };

        const [first, second] = await Promise.all([vault.prefetchPapers(), vault.prefetchPapers()]);

        expect(most).toBe(1);
        expect(first).toBe(4);
        // The second pass finds the four kept, with nothing left to download.
        expect(second).toBe(0);
        expect(downloads()).toBe(4);
    });

    it('a paper pulled while the pass on opening Documents runs comes down in the pass the sync asks for', async () => {
        const registo = paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf');
        store(registo, '%PDF-1.7 Registo');
        await db.mergePulledRecords('ship_documents', [registo]);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const serve = mem.serve;
        mem.serve = async (url) => {
            await held;
            return serve(url);
        };

        // Opening Documents starts a pass on the table as it is ...
        const opening = vault.prefetchPapers();
        await vi.waitFor(() => expect(downloads()).toBe(1));
        // ... then the page's own pull brings in the paper filed on the iPad, and its sync asks.
        const filed = paper(GREEK, 'Πιστοποιητικό νηολόγησης', 'Registration', 'jpg', '2026-10-09T09:00:00.000Z');
        store(filed, '\xff\xd8\xff\xe0 Πιστοποιητικό');
        await db.mergePulledRecords('ship_documents', [filed]);
        const afterSync = vault.prefetchPapers({ minGapMs: 30 * 60 * 1000 });
        release();

        expect(await opening).toBe(1);
        expect(await afterSync).toBe(1);
        expect(await vault.paperFileStates([row(GREEK)])).toEqual({ [GREEK]: 'local' });
    });

    it('stops when the account changes, and keeps nothing for the new one', async () => {
        await fileOnTheIpad();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const serve = mem.serve;
        let started = 0;
        mem.serve = async (url) => {
            started += 1;
            if (started === 1) await held;
            return serve(url);
        };

        const pass = vault.prefetchPapers();
        await vi.waitFor(() => expect(started).toBe(1));
        // The crew member signs in on this phone mid-download.
        await db.initLocalDatabase(CREW);
        release();
        await pass;

        expect(started).toBe(1);
        expect(vaultKeys(CREW)).toEqual([]);
        expect(indexOf(CREW)).toEqual({});
        expect(vaultKeys(SKIPPER)).toEqual([]);
    });

    it('after a sync, looks again at most once in 30 minutes, but a new paper comes down at once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T08:00:00.000Z'));
        const docs = await fileOnTheIpad();
        const gap = { minGapMs: 30 * 60 * 1000 };

        expect(await vault.prefetchPapers(gap)).toBe(4);
        // The iPad files one more; the next sync, ten minutes on, brings it down with one look.
        const extra = paper(
            '6f7a8b9c-0000-4000-8000-0000000000d6',
            'Crew list, Lyttelton',
            'Customs Clearances',
            'pdf',
            '2026-10-10T08:05:00.000Z',
        );
        store(extra, '%PDF-1.7 crew list');
        await db.mergePulledRecords('ship_documents', [extra]);
        vi.setSystemTime(Date.parse('2026-10-10T08:10:00.000Z'));
        let listsBefore = lists();
        expect(await vault.prefetchPapers(gap)).toBe(1);
        expect(lists()).toBe(listsBefore + 1);

        // The licence renewed on the iPad over the same path: a newer row, a new object.
        const radio = docs.find((doc) => doc.id === RADIO)!;
        const renewed = { ...radio, updated_at: '2026-10-10T08:12:00.000Z' };
        store(renewed, '%PDF-1.7 licence 2027', { eTag: '"etag-2027"' });
        await db.mergePulledRecords('ship_documents', [renewed]);
        vi.setSystemTime(Date.parse('2026-10-10T08:15:00.000Z'));
        const requests = h.state.requests.length;
        expect(await vault.prefetchPapers(gap)).toBe(0);
        expect(h.state.requests.length).toBe(requests);

        // Half an hour after the last full pass, it is looked at again.
        vi.setSystemTime(Date.parse('2026-10-10T08:31:00.000Z'));
        listsBefore = lists();
        expect(await vault.prefetchPapers(gap)).toBe(1);
        expect(lists()).toBe(listsBefore + 1);
        expect(fileText(`LIBRARY/${docsDir()}c-${RADIO}.pdf`).startsWith('%PDF-1.7 licence 2027')).toBe(true);
    });

    it('a pass that found no Wi-Fi never holds back the next one on Wi-Fi', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-10-10T08:00:00.000Z'));
        const docs = await fileOnTheIpad();
        const gap = { minGapMs: 30 * 60 * 1000 };
        expect(await vault.prefetchPapers(gap)).toBe(4);
        const radio = docs.find((doc) => doc.id === RADIO)!;
        const renewed = { ...radio, updated_at: '2026-10-10T08:20:00.000Z' };
        store(renewed, '%PDF-1.7 licence 2027', { eTag: '"etag-2027"' });
        await db.mergePulledRecords('ship_documents', [renewed]);

        // Ashore on cellular, 31 minutes on: a sync asks, nothing comes down.
        h.state.network = { connected: true, connectionType: 'cellular' };
        vi.setSystemTime(Date.parse('2026-10-10T08:31:00.000Z'));
        expect(await vault.prefetchPapers(gap)).toBe(0);
        expect(downloads()).toBe(4);

        // Back aboard on the marina Wi-Fi four minutes later: the pass runs.
        h.state.network = { connected: true, connectionType: 'wifi' };
        vi.setSystemTime(Date.parse('2026-10-10T08:35:00.000Z'));
        expect(await vault.prefetchPapers(gap)).toBe(1);
        expect(fileText(`LIBRARY/${docsDir()}c-${RADIO}.pdf`).startsWith('%PDF-1.7 licence 2027')).toBe(true);
    });

    it("on a crew phone keeps the skipper's shared papers, but never a Crew IDs paper of someone else's", async () => {
        await load(CREW);
        mem.serve = (url: string) => {
            const marker = '/storage/v1/object/sign/vessel_vault/';
            const { pathname } = new URL(url);
            return (
                h.state.objects.get(decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length)))
                    ?.bytes ?? 404
            );
        };
        const registo = paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf');
        const passport = paper(GREEK, 'Passport — Søren Holm', 'Crew Visas/IDs', 'pdf');
        store(registo, '%PDF-1.7 Registo');
        store(passport, '%PDF-1.7 Passport');
        await db.mergePulledRecords('ship_documents', [registo, passport]);

        expect(await vault.prefetchPapers()).toBe(1);

        expect(vaultKeys(CREW).map((key) => key.split('/').pop())).toEqual([`c-${REGISTO}.pdf`]);
    });
});

describe('collecting copies of papers that are gone', () => {
    it('a cached copy whose row the sweep pruned goes an hour on, with its index entry; one still there stays', async () => {
        const gone = paper(GREEK, 'Passport — Søren Holm', 'Crew Visas/IDs', 'pdf');
        const kept = paper(REGISTO, 'Registo de Propriedade', 'Registration', 'pdf');
        store(gone, '%PDF-1.7 Passport');
        store(kept, '%PDF-1.7 Registo');
        await db.mergePulledRecords('ship_documents', [gone, kept]);
        await vault.cacheCloudFile(row(GREEK));
        await vault.cacheCloudFile(row(REGISTO));
        expect(vaultKeys()).toHaveLength(2);

        // The skipper stops sharing it (or deletes it on the iPad): the sweep prunes the row.
        await db.prunePulledTable('ship_documents', new Set([REGISTO]));

        expect(await vault.gcVaultFiles({ now: Date.now() })).toBe(0);
        expect(vaultKeys()).toHaveLength(2);
        expect(await vault.gcVaultFiles({ now: Date.now() + 2 * HOUR })).toBe(1);

        expect(vaultKeys().map((key) => key.split('/').pop())).toEqual([`c-${REGISTO}.pdf`]);
        expect(Object.keys(indexOf())).toEqual([REGISTO]);
    });

    it('a cached copy whose file was removed on another device goes an hour on', async () => {
        const doc = paper(RADIO, 'Ship radio licence', 'Radio/MMSI', 'pdf');
        store(doc, '%PDF-1.7 licence');
        await db.mergePulledRecords('ship_documents', [doc]);
        await vault.cacheCloudFile(row(RADIO));

        await db.mergePulledRecords('ship_documents', [
            { ...doc, file_uri: null, updated_at: '2026-10-11T00:00:00.000Z' },
        ]);
        expect(await vault.gcVaultFiles({ now: Date.now() + 2 * HOUR })).toBe(1);

        expect(vaultKeys()).toEqual([]);
        expect(indexOf()[RADIO]).toBeUndefined();
    });

    it('the Wi-Fi pass collects them too', async () => {
        const gone = paper(GREEK, 'Passport — Søren Holm', 'Crew Visas/IDs', 'pdf');
        store(gone, '%PDF-1.7 Passport');
        await db.mergePulledRecords('ship_documents', [gone]);
        await vault.cacheCloudFile(row(GREEK));
        await db.prunePulledTable('ship_documents', new Set());
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 2 * HOUR);
        // Its file is old enough too.
        for (const file of mem.files.values()) file.mtime -= 2 * HOUR;

        await vault.prefetchPapers();

        expect(vaultKeys()).toEqual([]);
    });
});

describe('review fixes (126-B3b)', () => {
    const PICKED_AT = Date.parse('2026-10-10T08:00:00.000Z');

    it('a file picked in a form left open over an hour outlives the pass after a sync, and files', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(PICKED_AT);
        const picked = await vault.saveAttachment(
            new File([bytesOf(8192, '%PDF-1.7 Insurance renewal')], 'Insurance renewal.pdf', {
                type: 'application/pdf',
            }),
        );
        if (!picked.ok) throw new Error('not saved');
        const key = `LIBRARY/${picked.uri.slice('local-vault://'.length)}`;

        // He locks the phone with the form open; 70 minutes on, the catch-up sync's pass runs on Wi-Fi.
        vi.setSystemTime(PICKED_AT + 70 * 60 * 1000);
        await vault.prefetchPapers({ minGapMs: 30 * 60 * 1000 });
        expect(mem.files.has(key)).toBe(true);

        // He taps Save: the paper is filed with its file, which opens.
        await db.insertLocal('ship_documents', {
            ...paper(REGISTO, 'Insurance renewal', 'Insurance', 'pdf'),
            file_uri: picked.uri,
        });
        await vault.recordLocalCopy(REGISTO, picked.uri, picked.bytes);
        expect(await vault.localCopyFor(row(REGISTO))).toMatchObject({
            path: picked.uri.slice('local-vault://'.length),
            fresh: true,
        });
    });

    it('a download in flight when the account is deleted leaves nothing of it on the phone', async () => {
        const passport = paper(GREEK, 'Passport — Søren Holm', 'Crew Visas/IDs', 'pdf');
        store(passport, '%PDF-1.7 Passport');
        await db.mergePulledRecords('ship_documents', [passport]);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const serve = mem.serve;
        mem.serve = async (url) => {
            await held;
            return serve(url);
        };

        const pass = vault.prefetchPapers();
        await vi.waitFor(() => expect(downloads()).toBe(1));
        // Account deletion purges the vault while the passport scan is still streaming.
        await vault.purgeVaultFilesForUser(SKIPPER);
        release();
        await pass;
        await vault.gcVaultFiles({ now: Date.now() + 2 * HOUR });

        expect([...mem.files.keys()].filter((key) => key.startsWith(`LIBRARY/vault/${token()}/`))).toEqual([]);
    });

    it("a row with this phone's own edit still queued never confirms a copy (its stamp is this phone's clock)", async () => {
        const doc = paper(RADIO, 'Ship radio licence', 'Radio/MMSI', 'pdf');
        store(doc, '%PDF-1.7 licence');
        await db.mergePulledRecords('ship_documents', [doc]);
        // A notes edit here, its push still queued: updated_at is this phone's clock.
        await db.updateLocal<ShipDocument>('ship_documents', RADIO, { notes: 'Renewal lodged in Papeete' });

        await vault.cacheCloudFile(row(RADIO));

        expect(indexOf()[RADIO].rowStamp).toBeUndefined();
        // So the next open with signal looks once more.
        const listsBefore = lists();
        await vault.cacheCloudFile(row(RADIO));
        expect(lists()).toBe(listsBefore + 1);
    });

    it('a copy of a file the paper no longer has (replaced on the iPad as a photo) says "Needs signal to open"', async () => {
        const doc = paper(REGISTO, 'Passport — Søren Holm', 'Crew Visas/IDs', 'pdf');
        store(doc, '%PDF-1.7 expired passport');
        await db.mergePulledRecords('ship_documents', [doc]);
        await vault.cacheCloudFile(row(REGISTO));
        expect(await vault.paperFileStates([row(REGISTO)])).toEqual({ [REGISTO]: 'local' });

        await db.mergePulledRecords('ship_documents', [
            {
                ...doc,
                file_uri: `supabase-storage://vessel_vault/${SKIPPER}/documents/${REGISTO}.jpg`,
                updated_at: '2026-10-11T00:00:00.000Z',
            },
        ]);

        expect(await vault.paperFileStates([row(REGISTO)])).toEqual({ [REGISTO]: 'cloud' });
    });

    it('a download on a stalled link gives up in a minute, not the plugin default of ten', async () => {
        const doc = paper(RADIO, 'Ship radio licence', 'Radio/MMSI', 'pdf');
        store(doc, '%PDF-1.7 licence');
        await db.mergePulledRecords('ship_documents', [doc]);
        const download = vi.spyOn(mem, 'downloadFile');

        await vault.cacheCloudFile(row(RADIO));

        expect(download).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 60_000, readTimeout: 60_000 }));
    });

    it('an old upload stored with no extension is kept by the type Storage lists, not as a ".pdf"', async () => {
        const doc = {
            ...paper(GREEK, 'Πιστοποιητικό νηολόγησης', 'Registration', 'heic'),
            file_uri: `supabase-storage://vessel_vault/${SKIPPER}/documents/${GREEK}`,
        };
        h.state.objects.set(`${SKIPPER}/documents/${GREEK}`, {
            bytes: bytesOf(4096, '\x00\x00\x00\x18ftypheic'),
            eTag: '"etag-heif"',
            updatedAt: AT,
            type: 'image/heif',
        });
        await db.mergePulledRecords('ship_documents', [doc]);

        const kept = await vault.cacheCloudFile(row(GREEK));

        expect(kept.copy).toMatchObject({ path: `${docsDir()}c-${GREEK}.heic`, ext: 'heic' });
    });
});
