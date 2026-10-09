/**
 * Ship's Documents live on the phone as files (126-B3a, binder audit DOC-1 and
 * DOC-2): a picked paper is written to Library/vault in bounded chunks, never
 * held as base64 in the binder table or the shared outbox; photos are shrunk;
 * files over 25 MiB are refused with their size; the copy this phone filed is
 * found again after the pull replaces its reference (but, with signal, never
 * trusted over the cloud's, which another device may have replaced); old
 * inline base64 is drained to files once; papers filed while signed out move
 * into the adopting account's folder; files nothing refers to, and copies of
 * papers that are gone, are collected; and account deletion removes them all.
 *
 * The real vaultFiles and the real LocalDatabase over the in-memory
 * filesystem. FileReader, createImageBitmap and the canvas are jsdom's or
 * stubs. Fictional papers on the fictional 'Kestrel'; sizes are typed arrays,
 * never real files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryFilesystem } from './helpers/memoryFilesystem';
import type { ShipDocument } from '../types';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
        isPluginAvailable: () => false,
        // As on iOS: the WebView serves a file:/// path from the app's own origin.
        convertFileSrc: (uri: string) => uri.replace('file://', 'capacitor://localhost/_capacitor_file_'),
    },
    registerPlugin: vi.fn(() => ({})),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));

type Vault = typeof import('../services/vessel/vaultFiles');
type Database = typeof import('../services/vessel/LocalDatabase');

const MiB = 1024 * 1024;
const SKIPPER = 'kestrel-skipper';
const AT = '2026-10-09T01:00:00.000Z';

let mem: MemoryFilesystem;
let vault: Vault;
let db: Database;

async function load(identity: string | null = SKIPPER): Promise<void> {
    vi.resetModules();
    localStorage.clear();
    // The binder files already live in Library on this phone (LocalDatabase.ts).
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    // The instance the mocked plugin is, whatever the module registry did.
    mem = (await import('@capacitor/filesystem')).Filesystem as unknown as MemoryFilesystem;
    mem.reset();
    db = await import('../services/vessel/LocalDatabase');
    await db.initLocalDatabase(identity);
    vault = await import('../services/vessel/vaultFiles');
}

const token = (identity: string | null) => db.identityFileToken(identity);
const docsDir = (identity: string | null = SKIPPER) => `vault/${token(identity)}/documents/`;
const vaultKeys = (identity: string | null = SKIPPER) =>
    [...mem.files.keys()].filter((key) => key.startsWith(`LIBRARY/${docsDir(identity)}`));
const writesSince = (mark: number) =>
    mem.calls.slice(mark).filter((c) => ['writeFile', 'appendFile', 'rename', 'deleteFile', 'rmdir'].includes(c.op))
        .length;

/** `size` bytes, starting with `head`, the rest a repeating pattern. */
function bytesOf(size: number, head: number[] | string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 251;
    const start = typeof head === 'string' ? Array.from(head, (c) => c.charCodeAt(0)) : head;
    bytes.set(start, 0);
    return bytes;
}

const PDF_HEAD = '%PDF-1.7\n';
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
const HEIC_HEAD = [0x00, 0x00, 0x00, 0x18, ...Array.from('ftypheic', (c) => c.charCodeAt(0))];
const DOCX_HEAD = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00];

function fileOf(name: string, size: number, head: number[] | string, type = ''): File {
    return new File([bytesOf(size, head)], name, { type });
}

const decode = (base64: string) => Uint8Array.from(Buffer.from(base64, 'base64'));
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
/** The ship_documents row, as the page reads it. */
const row = (id: string) =>
    db.getById<{ id: string; file_uri: string | null; updated_at: string }>('ship_documents', id)!;
const base64Of = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function paper(id: string, name: string, fileUri: string | null, updatedAt = AT): ShipDocument {
    return {
        id,
        user_id: SKIPPER,
        document_name: name,
        category: 'Registration',
        issue_date: null,
        expiry_date: null,
        file_uri: fileUri,
        notes: null,
        created_at: AT,
        updated_at: updatedAt,
    };
}

type Paper = ShipDocument;

/** Serve convertFileSrc URLs from the memory filesystem, as the WebView does. */
function serveVaultFiles() {
    const fetch = vi.fn(async (input: string) => {
        const file = mem.fileForUri(String(input));
        if (!file) return new Response('not found', { status: 404 });
        return new Response(decode(file.data), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
}

beforeEach(async () => {
    h.warn.mockReset();
    await load();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('saveAttachment', () => {
    it('writes a 24.9 MB PDF to Library in bounded chunks, never to Data or Documents', async () => {
        const size = Math.round(24.9 * MiB);
        const result = await vault.saveAttachment(fileOf('Registo de Propriedade.pdf', size, PDF_HEAD));

        expect(result).toMatchObject({ ok: true, bytes: size, ext: 'pdf' });
        if (!result.ok) throw new Error('not saved');
        expect(result.uri).toMatch(new RegExp(`^local-vault://${docsDir()}p-[0-9a-f-]{36}\\.pdf$`));

        const writes = mem.calls.filter((c) => c.op === 'writeFile' && c.path.startsWith(docsDir()));
        const appends = mem.calls.filter((c) => c.op === 'appendFile' && c.path.startsWith(docsDir()));
        expect(writes).toHaveLength(1);
        expect(appends.length).toBeGreaterThanOrEqual(11);
        // No one call carries more than ~2 MiB of bytes across the bridge.
        expect(Math.max(...[...writes, ...appends].map((c) => c.chars ?? 0))).toBeLessThanOrEqual(2_800_000);
        expect([...writes, ...appends].every((c) => c.directory === 'LIBRARY')).toBe(true);
        expect(mem.calls.some((c) => c.directory === 'DATA' || c.directory === 'DOCUMENTS')).toBe(false);

        const [key] = vaultKeys();
        const stored = decode(mem.files.get(key)!.data);
        expect(stored.length).toBe(size);
        expect(Buffer.from(stored).equals(Buffer.from(bytesOf(size, PDF_HEAD)))).toBe(true);
    });

    it('refuses 25.1 MB with its byte count, and writes nothing', async () => {
        const size = Math.round(25.1 * MiB);
        const result = await vault.saveAttachment(fileOf('Ship radio licence.pdf', size, PDF_HEAD));
        expect(result).toEqual({ ok: false, reason: 'too-large', bytes: size });
        expect(vaultKeys()).toEqual([]);
    });

    it('refuses a file the form does not take', async () => {
        const result = await vault.saveAttachment(fileOf('kestrel-tool.exe', 4096, 'MZ'));
        expect(result).toMatchObject({ ok: false, reason: 'unsupported-type' });
        expect(vaultKeys()).toEqual([]);
    });

    it('a file that cannot be read is read-failed, and leaves no partial file', async () => {
        class FailingReader {
            result: string | null = null;
            onload: (() => void) | null = null;
            onerror: ((e: unknown) => void) | null = null;
            readAsDataURL() {
                setTimeout(() => this.onerror?.(new Error('The file could not be read')), 0);
            }
        }
        vi.stubGlobal('FileReader', FailingReader);
        const result = await vault.saveAttachment(fileOf('Registo de Propriedade.pdf', MiB, PDF_HEAD));
        expect(result).toMatchObject({ ok: false, reason: 'read-failed' });
        expect(vaultKeys()).toEqual([]);
    });

    it('shrinks a photo over 2000 px to a JPEG no larger than 2000 px', async () => {
        const drawn: { width: number; height: number }[] = [];
        const close = vi.fn();
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => ({ width: 4032, height: 3024, close })),
        );
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
            () =>
                ({
                    fillStyle: '',
                    fillRect: vi.fn(),
                    drawImage: vi.fn(),
                }) as unknown as CanvasRenderingContext2D,
        );
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
            this: HTMLCanvasElement,
            callback: BlobCallback,
            type?: string,
        ) {
            drawn.push({ width: this.width, height: this.height });
            callback(new Blob([bytesOf(300_000, JPEG_HEAD)], { type: type ?? 'image/jpeg' }));
        });

        const result = await vault.saveAttachment(
            fileOf('Passport — Søren Holm.jpg', 6 * MiB, JPEG_HEAD, 'image/jpeg'),
        );

        expect(result).toMatchObject({ ok: true, ext: 'jpg', bytes: 300_000 });
        expect(drawn).toEqual([{ width: 2000, height: 1500 }]);
        expect(close).toHaveBeenCalled();
        const [key] = vaultKeys();
        expect(key).toMatch(/\.jpg$/);
        expect(decode(mem.files.get(key)!.data).length).toBe(300_000);
    });

    it('keeps the original photo when it cannot be decoded and is within the cap', async () => {
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => {
                throw new Error('The source image could not be decoded.');
            }),
        );
        const size = 5 * MiB;
        const result = await vault.saveAttachment(fileOf('船舶検査証書.jpg', size, JPEG_HEAD, 'image/jpeg'));
        expect(result).toMatchObject({ ok: true, ext: 'jpg', bytes: size });
        const [key] = vaultKeys();
        expect(decode(mem.files.get(key)!.data).length).toBe(size);
    });

    it('never decodes a huge scan (its bitmap alone could end the app): it is kept as it is', async () => {
        const decodeImage = vi.fn(async () => ({ width: 20000, height: 28000, close: vi.fn() }));
        vi.stubGlobal('createImageBitmap', decodeImage);
        // A PNG's IHDR: 20000 x 28000 px, 2.2 GB as a bitmap, a few MB on disk.
        const ihdr = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
        const size = 3 * MiB;
        const png = bytesOf(size, [...ihdr, 0x00, 0x00, 0x4e, 0x20, 0x00, 0x00, 0x6d, 0x60]);

        const result = await vault.saveAttachment(new File([png], 'Kestrel passage chart.png', { type: 'image/png' }));

        expect(decodeImage).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, ext: 'png', bytes: size });
    });

    it('a JPEG within the pixel budget is still decoded and shrunk', async () => {
        const decodeImage = vi.fn(async () => {
            throw new Error('not decodable here');
        });
        vi.stubGlobal('createImageBitmap', decodeImage);
        // SOF0 after an APP0: 4032 x 3024 px.
        const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xd0, 0x0f, 0xc0];
        await vault.saveAttachment(
            fileOf('Passport — Søren Holm.jpg', MiB, [...JPEG_HEAD, ...Array(10).fill(0), ...sof]),
        );
        expect(decodeImage).toHaveBeenCalledTimes(1);
    });
});

describe('the file type comes from the bytes, not the name', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'createImageBitmap',
            vi.fn(async () => {
                throw new Error('not decodable here');
            }),
        );
    });

    it('a PDF named .jpg is filed as a PDF, and is never treated as a photo', async () => {
        const result = await vault.saveAttachment(fileOf('Ship radio licence.jpg', 2 * MiB, PDF_HEAD, 'image/jpeg'));
        expect(result).toMatchObject({ ok: true, ext: 'pdf' });
        expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    });

    it('a HEIC photo (ftypheic) is filed as heic', async () => {
        const result = await vault.saveAttachment(fileOf('Πιστοποιητικό νηολόγησης.heic', MiB, HEIC_HEAD));
        expect(result).toMatchObject({ ok: true, ext: 'heic' });
    });

    it('a Word file (PK, named .docx) is filed as docx', async () => {
        const result = await vault.saveAttachment(fileOf('Passport — Søren Holm.docx', MiB, DOCX_HEAD));
        expect(result).toMatchObject({ ok: true, ext: 'docx' });
    });
});

describe('readForUpload', () => {
    it('hands the upload a Blob of the exact bytes, read by the WebView, never through readFile', async () => {
        const original = bytesOf(3 * MiB + 17, PDF_HEAD);
        const saved = await vault.saveAttachment(new File([original], 'Registo de Propriedade.pdf'));
        if (!saved.ok) throw new Error('not saved');
        const fetch = serveVaultFiles();
        const mark = mem.calls.length;

        const blob = await vault.readForUpload(saved.uri);

        expect(await bytesOfBlob(blob)).toEqual(original);
        expect(String(fetch.mock.calls[0][0])).toMatch(/^capacitor:\/\/localhost\/_capacitor_file_\/Library\/vault\//);
        expect(mem.calls.slice(mark).some((c) => c.op === 'readFile')).toBe(false);
    });

    it('a missing file throws "Local attachment missing"', async () => {
        serveVaultFiles();
        await expect(vault.readForUpload(`local-vault://${docsDir()}p-gone.pdf`)).rejects.toThrow(
            'Local attachment missing',
        );
    });
});

describe('the index of copies this phone keeps', () => {
    it('is written atomically: a temporary file, then a rename', async () => {
        const saved = await vault.saveAttachment(fileOf('Registo de Propriedade.pdf', MiB, PDF_HEAD));
        if (!saved.ok) throw new Error('not saved');
        const mark = mem.calls.length;

        await vault.recordLocalCopy('doc-registo', saved.uri, saved.bytes);

        const steps = mem.calls.slice(mark).filter((c) => c.op === 'writeFile' || c.op === 'rename');
        expect(steps.map((c) => [c.op, c.path])).toEqual([
            ['writeFile', `vault/${token(SKIPPER)}/index.json.tmp`],
            ['rename', `vault/${token(SKIPPER)}/index.json.tmp`],
        ]);
        expect(mem.files.has(`LIBRARY/vault/${token(SKIPPER)}/index.json`)).toBe(true);
        expect(mem.files.has(`LIBRARY/vault/${token(SKIPPER)}/index.json.tmp`)).toBe(false);
    });

    it('finds the copy again after the pull replaces file_uri, but never calls it current over the cloud', async () => {
        const saved = await vault.saveAttachment(fileOf('Registo de Propriedade.pdf', MiB, PDF_HEAD));
        if (!saved.ok) throw new Error('not saved');
        const id = '7f3e2d1c-0000-4000-8000-00000000000a';
        await db.insertLocal('ship_documents', paper(id, 'Registo de Propriedade', saved.uri));
        await vault.recordLocalCopy(id, saved.uri, saved.bytes);
        expect(await vault.localCopyFor(row(id))).toMatchObject({ fresh: true, ext: 'pdf' });

        // The push uploads it (and notes where it went); the pull brings the server's row back.
        const remote = `supabase-storage://vessel_vault/${SKIPPER}/documents/${id}.pdf`;
        await vault.notePushedCopy(id, saved.uri, remote);
        await db.removeSynced(db.getFullQueue().map((item) => item.id));
        await db.mergePulledRecords('ship_documents', [
            paper(id, 'Registo de Propriedade', remote, '2026-10-09T02:00:00.000Z'),
        ]);

        // Still this phone's copy for no signal; but another device may since
        // have replaced the file at the same cloud path, so with signal the
        // cloud is asked first (126-B3b compares the stored object's stamp).
        const copy = await vault.localCopyFor(row(id));
        expect(copy).toMatchObject({ fresh: false, ext: 'pdf', bytes: MiB });
        expect(copy?.path).toBe(saved.uri.slice('local-vault://'.length));
        const index = JSON.parse(mem.files.get(`LIBRARY/vault/${token(SKIPPER)}/index.json`)!.data) as {
            entries: Record<string, { remote?: string; pushedAt?: string }>;
        };
        expect(index.entries[id].remote).toBe(remote);
        expect(index.entries[id].pushedAt).toEqual(expect.any(String));
    });

    it("a push of an older file never claims the paper's newer copy", async () => {
        const older = await vault.saveAttachment(fileOf('Ship radio licence.pdf', MiB, PDF_HEAD));
        const newer = await vault.saveAttachment(fileOf('Ship radio licence.pdf', MiB, PDF_HEAD));
        if (!older.ok || !newer.ok) throw new Error('not saved');
        await vault.recordLocalCopy('doc-radio', newer.uri, newer.bytes);

        await vault.notePushedCopy('doc-radio', older.uri, 'supabase-storage://vessel_vault/x/documents/doc-radio.pdf');

        const index = JSON.parse(mem.files.get(`LIBRARY/vault/${token(SKIPPER)}/index.json`)!.data) as {
            entries: Record<string, { path: string; remote?: string }>;
        };
        expect(index.entries['doc-radio']).toMatchObject({ path: newer.uri.slice('local-vault://'.length) });
        expect(index.entries['doc-radio'].remote).toBeUndefined();
    });
});

describe('papers filed while signed out', () => {
    const anonymousKeys = () => [...mem.files.keys()].filter((key) => key.startsWith('LIBRARY/vault/anonymous/'));
    const anonymousFiles = () => anonymousKeys().filter((key) => key.includes('/documents/'));
    const indexOf = (identity: string | null) =>
        JSON.parse(mem.files.get(`LIBRARY/vault/${token(identity)}/index.json`)?.data ?? '{"entries":{}}') as {
            entries: Record<string, { path: string; remote?: string }>;
        };

    /** In browse mode: file 'Passport — Søren Holm' with a scan; then sign in, and the account adopts it. */
    async function fileSignedOutThenSignIn(): Promise<{ id: string; uri: string }> {
        await load(null);
        const saved = await vault.saveAttachment(fileOf('Passport — Søren Holm.pdf', MiB, PDF_HEAD));
        if (!saved.ok) throw new Error('not saved');
        const id = '6a7b8c9d-0000-4000-8000-0000000000c1';
        await db.insertLocal('ship_documents', { ...paper(id, 'Passport — Søren Holm', saved.uri), user_id: '' });
        await vault.recordLocalCopy(id, saved.uri, saved.bytes);
        await db.initLocalDatabase(SKIPPER);
        expect(row(id).file_uri).toBe(saved.uri);
        return { id, uri: saved.uri };
    }

    it("move into the account's own folder at its tidy: row, outbox and index follow", async () => {
        const { id, uri } = await fileSignedOutThenSignIn();

        await vault.gcVaultFiles();

        expect(anonymousFiles()).toEqual([]);
        expect(indexOf(null).entries[id]).toBeUndefined();
        const [moved] = vaultKeys();
        const movedUri = `local-vault://${moved.slice('LIBRARY/'.length)}`;
        expect(movedUri).toBe(uri.replace('vault/anonymous/', `vault/${token(SKIPPER)}/`));
        expect(row(id).file_uri).toBe(movedUri);
        const [insert] = db.getFullQueue();
        expect((JSON.parse(insert.payload) as { file_uri: string }).file_uri).toBe(movedUri);
        expect(indexOf(SKIPPER).entries[id].path).toBe(moved.slice('LIBRARY/'.length));
        expect(await vault.localCopyFor(row(id))).toMatchObject({ fresh: true, bytes: MiB });
    });

    it('move across even once pushed and pulled, when only the signed-out index still names the copy', async () => {
        const { id } = await fileSignedOutThenSignIn();
        await db.removeSynced(db.getFullQueue().map((item) => item.id));
        const remote = `supabase-storage://vessel_vault/${SKIPPER}/documents/${id}.pdf`;
        await db.mergePulledRecords('ship_documents', [
            paper(id, 'Passport — Søren Holm', remote, '2026-10-09T04:00:00.000Z'),
        ]);

        await vault.gcVaultFiles();

        expect(anonymousFiles()).toEqual([]);
        expect(vaultKeys()).toHaveLength(1);
        // With no signal it still opens from the account's own copy.
        expect(await vault.localCopyFor(row(id))).toMatchObject({ ext: 'pdf', bytes: MiB });
    });

    it("a skipper's shared paper is never taken from the signed-out folder into a crew account", async () => {
        const { id } = await fileSignedOutThenSignIn();
        // On this phone a crew member signs in later; the skipper's paper reaches them through the shared binder.
        await db.initLocalDatabase('albatross-crew');
        await db.mergePulledRecords('ship_documents', [
            paper(id, 'Passport — Søren Holm', `supabase-storage://vessel_vault/${SKIPPER}/documents/${id}.pdf`),
        ]);

        await vault.gcVaultFiles();

        expect(vaultKeys('albatross-crew')).toEqual([]);
        expect(anonymousFiles()).toHaveLength(1);
    });

    it('account deletion leaves nothing of them under the signed-out folder, even before the tidy', async () => {
        const { id } = await fileSignedOutThenSignIn();

        await vault.purgeVaultFilesForUser(SKIPPER);

        expect(anonymousFiles()).toEqual([]);
        expect(indexOf(null).entries[id]).toBeUndefined();
        expect([...mem.files.keys()].some((key) => key.startsWith(`LIBRARY/vault/${token(SKIPPER)}/`))).toBe(false);
    });
});

describe('gcVaultFiles', () => {
    const HOUR = 60 * 60 * 1000;
    const NOW = Date.parse('2026-10-09T12:00:00.000Z');

    function plant(name: string, ageMs: number, identity: string | null = SKIPPER): string {
        const path = `${docsDir(identity)}${name}`;
        mem.files.set(`LIBRARY/${path}`, { data: base64Of(bytesOf(64, PDF_HEAD)), mtime: NOW - ageMs });
        return `local-vault://${path}`;
    }

    it('collects only an unreferenced file older than an hour, and reads only Documents queue items', async () => {
        const orphan = plant('p-orphan.pdf', 2 * HOUR);
        const queuedOnly = plant('p-queued.pdf', 2 * HOUR);
        const current = plant('p-current.pdf', 2 * HOUR);
        const fresh = plant('p-picked-just-now.pdf', 10 * 60 * 1000);
        const id = '5e6f7a8b-0000-4000-8000-00000000000b';
        await db.insertLocal('ship_documents', paper(id, 'Ship radio licence', null));
        // Two edits: the first attachment is now named only by a queued UPDATE.
        await db.updateLocal<Paper>('ship_documents', id, { file_uri: queuedOnly });
        await db.updateLocal<Paper>('ship_documents', id, { file_uri: current });
        // A Galley note that happens to name a vault path: only the table keeps it unparsed.
        await db.insertLocal('recipes', {
            id: 'recipe-feijoada',
            title: 'Feijoada',
            notes: `See local-vault://${docsDir()}p-orphan.pdf`,
        });
        const parse = vi.spyOn(JSON, 'parse');

        const removed = await vault.gcVaultFiles({ now: NOW });

        expect(removed).toBe(1);
        const left = vaultKeys().map((key) => key.split('/').pop());
        expect(left.sort()).toEqual(['p-current.pdf', 'p-picked-just-now.pdf', 'p-queued.pdf']);
        expect(orphan).toContain('p-orphan.pdf');
        expect(fresh).toContain('p-picked');
        // Never another table's queue items.
        expect(parse.mock.calls.some(([text]) => String(text).includes('Feijoada'))).toBe(false);
    });

    it('keeps a file only the index names (a paper kept on this phone only)', async () => {
        const kept = plant('p-kept.pdf', 3 * HOUR);
        const id = '0c1d2e3f-0000-4000-8000-0000000000c2';
        await db.insertLocal('ship_documents', paper(id, 'Ship radio licence', null));
        await vault.recordLocalCopy(id, kept, 64, { tooLarge: true });
        expect(await vault.gcVaultFiles({ now: Date.now() + 2 * HOUR })).toBe(0);
        expect(vaultKeys()).toHaveLength(1);
    });

    it('forgets the copy of a paper that is gone, an hour on, and collects its file', async () => {
        const later = Date.now() + 2 * HOUR;
        const gone = plant('p-gone.jpg', 3 * HOUR);
        const kept = plant('p-kept.pdf', 3 * HOUR);
        const deletedId = '1d2e3f4a-0000-4000-8000-0000000000c3';
        const keptId = '2e3f4a5b-0000-4000-8000-0000000000c4';
        // 'Passport — Søren Holm' was deleted (on this phone or another; its DELETE has gone).
        await vault.recordLocalCopy(deletedId, gone, 64);
        await db.insertLocal('ship_documents', paper(keptId, 'Registo de Propriedade', null));
        await vault.recordLocalCopy(keptId, kept, 64);

        // Not within the hour.
        expect(await vault.gcVaultFiles({ now: Date.now() })).toBe(0);
        expect(await vault.gcVaultFiles({ now: later })).toBe(1);

        expect(vaultKeys().map((key) => key.split('/').pop())).toEqual(['p-kept.pdf']);
        const index = JSON.parse(mem.files.get(`LIBRARY/vault/${token(SKIPPER)}/index.json`)!.data) as {
            entries: Record<string, unknown>;
        };
        expect(Object.keys(index.entries)).toEqual([keptId]);
    });

    it('signed out, the index is never pruned (an account that adopts the papers takes their copies)', async () => {
        await load(null);
        const kept = plant('p-kept.pdf', 3 * HOUR, null);
        await vault.recordLocalCopy('doc-browse', kept, 64);
        expect(await vault.gcVaultFiles({ now: Date.now() + 2 * HOUR })).toBe(0);
        expect(vaultKeys(null)).toHaveLength(1);
    });
});

describe('drainInlineAttachments', () => {
    const queueFile = () => `LIBRARY/vessel_${token(SKIPPER)}_sync_queue.json`;
    const queueSize = () => mem.files.get(queueFile())!.data.length;

    it('moves one inline file to one vault file, rewrites the row and every payload, and is idempotent', async () => {
        const bytes = bytesOf(3 * MiB, PDF_HEAD);
        const inline = `data:application/pdf;base64,${base64Of(bytes)}`;
        const id = '9c0d1e2f-0000-4000-8000-00000000000c';
        await db.insertLocal('ship_documents', paper(id, 'Registo de Propriedade', inline));
        await db.updateLocal<Paper>('ship_documents', id, { notes: 'Lisboa', file_uri: inline });
        await db.updateLocal<Paper>('ship_documents', id, { expiry_date: '2027-03-31', file_uri: inline });
        const before = queueSize();

        const outcome = await vault.drainInlineAttachments();

        expect(outcome).toMatchObject({ moved: 1, keptLocal: 0 });
        const files = vaultKeys();
        expect(files).toHaveLength(1);
        expect(Buffer.from(decode(mem.files.get(files[0])!.data)).equals(Buffer.from(bytes))).toBe(true);
        const path = `local-vault://${files[0].slice('LIBRARY/'.length)}`;
        const payloads = db.getFullQueue().map((item) => JSON.parse(item.payload) as { file_uri?: string });
        expect(payloads).toHaveLength(3);
        expect(payloads.every((payload) => payload.file_uri === path)).toBe(true);
        expect(db.getById<{ file_uri: string }>('ship_documents', id)?.file_uri).toBe(path);
        expect(before - queueSize()).toBeGreaterThan(9 * 1000 * 1000);
        expect(await vault.localCopyFor(row(id))).toMatchObject({ fresh: true, bytes: 3 * MiB });
        expect(h.warn).toHaveBeenCalledWith('documents: drained 1 attachments (0 kept on this phone only)');

        const mark = mem.calls.length;
        expect(await vault.drainInlineAttachments()).toMatchObject({ moved: 0, keptLocal: 0 });
        expect(writesSince(mark)).toBe(0);
    });

    it('keeps a 30 MB inline file on this phone only: the row and payloads lose the file, the index keeps it', async () => {
        const inline = `data:application/pdf;base64,${base64Of(bytesOf(30 * MiB, PDF_HEAD))}`;
        const id = '1a2b3c4d-0000-4000-8000-00000000000d';
        await db.insertLocal('ship_documents', paper(id, 'Ship radio licence', inline));

        const outcome = await vault.drainInlineAttachments();

        expect(outcome).toMatchObject({ moved: 1, keptLocal: 1 });
        expect(db.getById<{ file_uri: string | null }>('ship_documents', id)?.file_uri).toBeNull();
        const [insert] = db.getFullQueue();
        expect((JSON.parse(insert.payload) as { file_uri: unknown }).file_uri).toBeNull();
        const index = JSON.parse(mem.files.get(`LIBRARY/vault/${token(SKIPPER)}/index.json`)!.data) as {
            entries: Record<string, { tooLarge?: boolean; bytes: number }>;
        };
        expect(index.entries[id]).toMatchObject({ tooLarge: true, bytes: 30 * MiB });
        expect(vaultKeys()).toHaveLength(1);
        // It still opens on this phone.
        expect(await vault.localCopyFor(row(id))).toMatchObject({ fresh: true, ext: 'pdf' });
        expect(h.warn).toHaveBeenCalledWith('documents: drained 1 attachments (1 kept on this phone only)');
    });

    it("over the cap, an UPDATE whose INSERT already reached the server leaves the server's file alone", async () => {
        const inline = `data:application/pdf;base64,${base64Of(bytesOf(30 * MiB, PDF_HEAD))}`;
        const id = '4d5e6f7a-0000-4000-8000-0000000000d1';
        // Filed on an older build: its INSERT uploaded the 30 MB survey (the
        // bucket had no limit then); a notes edit re-sent it and keeps failing.
        await db.insertLocal('ship_documents', paper(id, 'Kestrel out-of-water survey', inline));
        await db.removeSynced(db.getFullQueue().map((item) => item.id));
        await db.updateLocal<Paper>('ship_documents', id, { notes: 'Haul-out, Opua', file_uri: inline });

        const outcome = await vault.drainInlineAttachments();

        expect(outcome).toMatchObject({ moved: 1, keptLocal: 1 });
        const [update] = db.getFullQueue();
        expect(update.mutation_type).toBe('UPDATE');
        const payload = JSON.parse(update.payload) as Record<string, unknown>;
        // No file_uri: the push neither replaces nor deletes the stored object.
        expect('file_uri' in payload).toBe(false);
        expect(payload.notes).toBe('Haul-out, Opua');
        expect(row(id).file_uri).toBeNull();
        expect(await vault.localCopyFor(row(id))).toMatchObject({ fresh: true, bytes: 30 * MiB });
    });

    it('a paper re-filed while its old inline file is written keeps its new file', async () => {
        const inline = `data:application/pdf;base64,${base64Of(bytesOf(3 * MiB, PDF_HEAD))}`;
        const id = '5e6f7a8b-0000-4000-8000-0000000000d2';
        await db.insertLocal('ship_documents', paper(id, 'Registo de Propriedade', inline));
        // Hold the drain's write of the old file.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reached!: () => void;
        const writing = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const write = mem.writeFile.bind(mem);
        vi.spyOn(mem, 'writeFile').mockImplementation(async (options) => {
            if (options.path.includes('/documents/')) {
                reached();
                await gate;
            }
            return write(options);
        });

        const drained = vault.drainInlineAttachments();
        await writing;
        // Meanwhile the skipper replaces the file with a new scan and saves.
        const scan = `local-vault://${docsDir()}p-new-scan.pdf`;
        mem.files.set(`LIBRARY/${docsDir()}p-new-scan.pdf`, {
            data: base64Of(bytesOf(MiB, PDF_HEAD)),
            mtime: Date.now(),
        });
        await db.updateLocal<Paper>('ship_documents', id, { file_uri: scan });
        await vault.recordLocalCopy(id, scan, MiB);
        release();
        await drained;

        expect(row(id).file_uri).toBe(scan);
        const index = JSON.parse(mem.files.get(`LIBRARY/vault/${token(SKIPPER)}/index.json`)!.data) as {
            entries: Record<string, { path: string }>;
        };
        expect(index.entries[id].path).toBe(`${docsDir()}p-new-scan.pdf`);
        const [insert, update] = db.getFullQueue().map((item) => JSON.parse(item.payload) as { file_uri: string });
        // The INSERT still carries the old file (now a path), the UPDATE the new one.
        expect(insert.file_uri).toMatch(/^local-vault:\/\/.+\/p-[0-9a-f-]{36}\.pdf$/);
        expect(update.file_uri).toBe(scan);
    });

    it("indexes the paper's current file, not an older one a queued payload still carries", async () => {
        const older = `data:application/pdf;base64,${base64Of(bytesOf(30 * MiB, PDF_HEAD))}`;
        const current = `data:image/jpeg;base64,${base64Of(bytesOf(MiB, JPEG_HEAD))}`;
        const id = '3c4d5e6f-0000-4000-8000-00000000000f';
        await db.insertLocal('ship_documents', paper(id, '船舶検査証書', older));
        await db.updateLocal<Paper>('ship_documents', id, { file_uri: current });

        const outcome = await vault.drainInlineAttachments();

        // The 30 MB original can never upload and is no longer this paper's file: dropped.
        expect(outcome).toMatchObject({ moved: 2, keptLocal: 0 });
        const files = vaultKeys();
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/\.jpg$/);
        const [insert, update] = db.getFullQueue().map((item) => JSON.parse(item.payload) as { file_uri: unknown });
        expect(insert.file_uri).toBeNull();
        expect(update.file_uri).toBe(`local-vault://${files[0].slice('LIBRARY/'.length)}`);
        expect(row(id).file_uri).toBe(update.file_uri);
        const index = JSON.parse(mem.files.get(`LIBRARY/vault/${token(SKIPPER)}/index.json`)!.data) as {
            entries: Record<string, { path: string; tooLarge?: boolean }>;
        };
        expect(index.entries[id]).toMatchObject({ path: files[0].slice('LIBRARY/'.length) });
        expect(index.entries[id].tooLarge).toBeUndefined();
    });

    it('leaves a data: URI that is not base64 alone, and warns once', async () => {
        const inline = 'data:application/pdf,%25PDF-1.4%20Kestrel';
        const id = '2b3c4d5e-0000-4000-8000-00000000000e';
        await db.insertLocal('ship_documents', paper(id, 'Ship radio licence', inline));
        await db.updateLocal<Paper>('ship_documents', id, { notes: 'Wellington', file_uri: inline });

        const outcome = await vault.drainInlineAttachments();

        expect(outcome).toMatchObject({ moved: 0 });
        expect(db.getById<{ file_uri: string }>('ship_documents', id)?.file_uri).toBe(inline);
        expect(vaultKeys()).toEqual([]);
        const notBase64 = h.warn.mock.calls.filter(([message]) => String(message).includes('not base64'));
        expect(notBase64).toHaveLength(1);
    });
});

describe('purgeVaultFilesForUser', () => {
    it("removes this account's vault folder and never another's", async () => {
        const mine = await vault.saveAttachment(fileOf('Passport — Søren Holm.pdf', MiB, PDF_HEAD));
        if (!mine.ok) throw new Error('not saved');
        await vault.recordLocalCopy('doc-passport', mine.uri, mine.bytes);
        await db.initLocalDatabase('albatross-crew');
        const theirs = await vault.saveAttachment(fileOf('Ship radio licence.pdf', MiB, PDF_HEAD));
        if (!theirs.ok) throw new Error('not saved');

        await vault.purgeVaultFilesForUser(SKIPPER);

        const left = [...mem.files.keys()].filter((key) => key.startsWith('LIBRARY/vault/'));
        expect(left.some((key) => key.includes(token(SKIPPER)))).toBe(false);
        expect(left.some((key) => key.includes(token('albatross-crew')))).toBe(true);
    });
});
