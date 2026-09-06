/**
 * Private vessel records left the Files-visible Documents folder.
 *
 * Info.plist turns on UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace
 * so the S-63 chart fingerprint is findable in the Files app — a deliberate
 * export. That makes the WHOLE Documents folder browsable, and LocalDatabase
 * was writing inventory, maintenance history, ship documents, crew profiles
 * and the sync queue there as plaintext JSON (external audit, 2026-09-05).
 *
 * The database now lives in Directory.Library, and existing files are moved
 * once on the first initialisation. The move is the risky part — a mistake
 * here loses a skipper's inventory, and build 102 made exactly that mistake:
 * it moved Documents → Directory.Data, which on iOS IS Documents, so every
 * file was "already at the destination", the copy was skipped and the delete
 * removed the only copy. So this file drives the move against a fake
 * filesystem that knows which directory a file is in AND can be told that two
 * directories are one folder. The shared mock in tests/setup.ts cannot, which
 * is exactly why a directory-blind harness could not have caught either bug.
 *
 * Properties, in order of how much they matter:
 *   0. nothing is deleted until the platform confirms Documents and Library
 *      are different folders — the same answer for both means hands off
 *   1. copy THEN delete — a crash between the two leaves both copies, never none
 *   2. a file already in Data is not overwritten by an older Documents copy
 *   3. a file that will not move is left where it is, and the marker stays off
 *   4. the marker is set only after a complete pass, and then Documents is
 *      never listed again
 *   5. nothing but vessel_* is touched — the fingerprint stays in Documents
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
    type Entry = { path: string; directory: string };
    type Move = { from: string; to: string; directory: string; toDirectory?: string };
    const store = new Map<string, Map<string, string>>();
    const dir = (d: string) => {
        if (!store.has(d)) store.set(d, new Map());
        return store.get(d)!;
    };
    const entry = (directory: string, name: string) => ({
        name,
        type: 'file' as const,
        size: 0,
        ctime: 0,
        mtime: 0,
        uri: `mock://${directory}/${name}`,
    });
    /** The real behaviour of every fake, kept separately so a test that overrides
     *  one can be undone: vi.clearAllMocks() clears call history but KEEPS a
     *  mockImplementation, and one leaked from test 4 into test 5. */
    const impl = {
        readdir: async ({ directory }: Entry) => ({
            files: [...dir(directory).keys()].map((name) => entry(directory, name)),
        }),
        readFile: async ({ path, directory }: Entry) => {
            const d = dir(directory);
            if (!d.has(path)) throw new Error(`ENOENT ${directory}/${path}`);
            return { data: d.get(path)! };
        },
        writeFile: async ({ path, directory, data }: Entry & { data: string }) => {
            dir(directory).set(path, String(data));
            return { uri: `mock://${directory}/${path}` };
        },
        deleteFile: async ({ path, directory }: Entry) => {
            if (!dir(directory).delete(path)) throw new Error(`ENOENT ${directory}/${path}`);
        },
        rename: async ({ from, to, directory, toDirectory }: Move) => {
            const src = dir(directory);
            const value = src.get(from);
            if (value === undefined) throw new Error(`ENOENT ${directory}/${from}`);
            src.delete(from);
            dir(toDirectory ?? directory).set(to, value);
        },
        copy: async ({ from, to, directory, toDirectory }: Move) => {
            const value = dir(directory).get(from);
            if (value === undefined) throw new Error(`ENOENT ${directory}/${from}`);
            dir(toDirectory ?? directory).set(to, value);
            return { uri: `mock://${toDirectory ?? directory}/${to}` };
        },
        stat: async () => undefined,
        mkdir: async () => undefined,
        getUri: async ({ path, directory }: Entry) => ({ uri: `mock://${directory}/${path}` }),
    };
    const Filesystem = {
        readdir: vi.fn(impl.readdir),
        readFile: vi.fn(impl.readFile),
        writeFile: vi.fn(impl.writeFile),
        deleteFile: vi.fn(impl.deleteFile),
        rename: vi.fn(impl.rename),
        copy: vi.fn(impl.copy),
        stat: vi.fn(impl.stat),
        mkdir: vi.fn(impl.mkdir),
        getUri: vi.fn(impl.getUri),
    };
    const restore = () => {
        Filesystem.readdir.mockImplementation(impl.readdir);
        Filesystem.readFile.mockImplementation(impl.readFile);
        Filesystem.writeFile.mockImplementation(impl.writeFile);
        Filesystem.deleteFile.mockImplementation(impl.deleteFile);
        Filesystem.rename.mockImplementation(impl.rename);
        Filesystem.copy.mockImplementation(impl.copy);
        Filesystem.getUri.mockImplementation(impl.getUri);
    };
    return { store, dir, Filesystem, restore };
});

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: fake.Filesystem,
    Directory: { Documents: 'DOCUMENTS', Data: 'DATA', Library: 'LIBRARY', Cache: 'CACHE' },
    Encoding: { UTF8: 'utf8' },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const MARKER = 'thalassa_localdb_moved_to_library';
const STALE_MARKER = 'thalassa_localdb_moved_to_data';
const DOCS = 'DOCUMENTS';
const LIB = 'LIBRARY';

function scopedFile(identity: string, legacyFile: string): string {
    const token = `user_${Array.from(new TextEncoder().encode(identity), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    return `vessel_${token}_${legacyFile.replace(/^vessel_/, '')}`;
}
const INVENTORY = scopedFile('user-a', 'vessel_inventory_items.json');
const QUEUE = scopedFile('user-a', 'vessel_sync_queue.json');
const record = { 'stores-1': { id: 'stores-1', item_name: 'Emergency water', quantity: 6 } };

async function init(identity: string | null = 'user-a') {
    vi.resetModules();
    const database = await import('../services/vessel/LocalDatabase');
    await database.initLocalDatabase(identity);
    return database;
}

describe('LocalDatabase leaves the Documents folder', () => {
    beforeEach(() => {
        fake.store.clear();
        vi.clearAllMocks();
        fake.restore();
        localStorage.clear();
    });

    it('moves every vessel_* file from Documents into Library and reads it from there', async () => {
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));
        fake.dir(DOCS).set(QUEUE, '[]');

        await init();

        expect(fake.dir(LIB).get(INVENTORY)).toBe(JSON.stringify(record));
        expect(fake.dir(DOCS).has(INVENTORY)).toBe(false);
        expect(fake.dir(DOCS).has(QUEUE)).toBe(false);
        // Copied from Documents INTO Data, by name.
        expect(fake.Filesystem.copy).toHaveBeenCalledWith(
            expect.objectContaining({ from: INVENTORY, directory: DOCS, to: INVENTORY, toDirectory: LIB }),
        );
        // And every read of it afterwards went to Data.
        const reads = fake.Filesystem.readFile.mock.calls.map((c) => c[0] as { path: string; directory: string });
        expect(reads.some((r) => r.path === INVENTORY && r.directory === LIB)).toBe(true);
        expect(reads.some((r) => r.directory === DOCS)).toBe(false);
    });

    it('copies BEFORE it deletes — a crash between the two leaves two copies, never none', async () => {
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));
        const order: string[] = [];
        fake.Filesystem.copy.mockImplementationOnce(async (args) => {
            order.push('copy');
            fake.dir(args.toDirectory ?? args.directory).set(args.to, fake.dir(args.directory).get(args.from)!);
            return { uri: 'mock://copied' };
        });
        fake.Filesystem.deleteFile.mockImplementationOnce(async (args) => {
            order.push('delete');
            fake.dir(args.directory).delete(args.path);
        });

        await init();

        expect(order).toEqual(['copy', 'delete']);
    });

    it('does not overwrite a file already in Library with an older Documents copy, but still clears Documents', async () => {
        const newer = { 'stores-1': { id: 'stores-1', item_name: 'Emergency water', quantity: 12 } };
        fake.dir(LIB).set(INVENTORY, JSON.stringify(newer));
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));

        await init();

        expect(fake.Filesystem.copy).not.toHaveBeenCalled();
        expect(fake.dir(LIB).get(INVENTORY)).toBe(JSON.stringify(newer));
        expect(fake.dir(DOCS).has(INVENTORY)).toBe(false);
    });

    it('leaves a file it cannot copy where it is, and does NOT set the marker', async () => {
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));
        fake.dir(DOCS).set(QUEUE, '[]');
        fake.Filesystem.copy.mockImplementation(async (args) => {
            if (args.from === INVENTORY) throw new Error('disk full');
            fake.dir(args.toDirectory ?? args.directory).set(args.to, fake.dir(args.directory).get(args.from)!);
            return { uri: 'mock://copied' };
        });

        await init();

        // The failed one stays in Documents, untouched, for the next launch.
        expect(fake.dir(DOCS).has(INVENTORY)).toBe(true);
        expect(fake.dir(LIB).has(INVENTORY)).toBe(false);
        // The one that worked moved.
        expect(fake.dir(DOCS).has(QUEUE)).toBe(false);
        expect(fake.dir(LIB).has(QUEUE)).toBe(true);
        expect(localStorage.getItem(MARKER)).toBeNull();
    });

    it('sets the marker after a complete pass and never lists Documents again', async () => {
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));
        await init();
        expect(localStorage.getItem(MARKER)).toBe('1');

        vi.clearAllMocks();
        await init();
        const listed = fake.Filesystem.readdir.mock.calls.map((c) => (c[0] as { directory: string }).directory);
        expect(listed).not.toContain(DOCS);
        expect(listed).toContain(LIB);
    });

    it('a fresh device with nothing in Documents sets the marker straight away', async () => {
        await init();
        expect(localStorage.getItem(MARKER)).toBe('1');
    });

    it('a Documents listing that fails leaves the marker unset, so the next launch looks again', async () => {
        fake.Filesystem.readdir.mockImplementationOnce(async () => {
            throw new Error('documents unavailable');
        });
        await init();
        expect(localStorage.getItem(MARKER)).toBeNull();
    });

    it('moves the .tmp and .bak recovery copies too — and the recovery path then finishes the swap', async () => {
        fake.dir(DOCS).set(`${INVENTORY}.bak`, JSON.stringify(record));
        await init();
        // Moved out of Documents...
        expect(fake.dir(DOCS).has(`${INVENTORY}.bak`)).toBe(false);
        expect(fake.Filesystem.copy).toHaveBeenCalledWith(
            expect.objectContaining({ from: `${INVENTORY}.bak`, directory: DOCS, toDirectory: LIB }),
        );
        // ...and once in Data, readJsonFile saw a lone backup with no live file
        // and completed the interrupted atomic swap: the .bak BECAME the file.
        // That is the recovery contract doing its job on the moved copy.
        expect(fake.dir(LIB).has(`${INVENTORY}.bak`)).toBe(false);
        expect(fake.dir(LIB).get(INVENTORY)).toBe(JSON.stringify(record));
    });

    it('touches nothing but vessel_* — the S-63 fingerprint stays where the skipper can find it', async () => {
        fake.dir(DOCS).set('thalassa-s63-fingerprint.txt', 'fingerprint');
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));
        await init();
        expect(fake.dir(DOCS).get('thalassa-s63-fingerprint.txt')).toBe('fingerprint');
        expect(fake.dir(LIB).has('thalassa-s63-fingerprint.txt')).toBe(false);
    });

    it('refuses to delete anything when the platform says Documents and Library are one folder — the build 102 fault', async () => {
        // On iOS, @capacitor/filesystem resolves Data and Documents to the same
        // folder. Build 102 "moved" Documents → Data: every file was already
        // "at the destination", so the copy was skipped and the delete removed
        // the only copy. The guard must make that impossible.
        fake.Filesystem.getUri.mockImplementation(async ({ path }: { path: string }) => ({
            uri: `mock://SAME/${path}`,
        }));
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));
        fake.dir(DOCS).set(QUEUE, '[]');

        await init();

        const deletes = fake.Filesystem.deleteFile.mock.calls.map((c) => c[0] as { directory: string });
        expect(deletes.some((d) => d.directory === DOCS)).toBe(false);
        expect(fake.Filesystem.copy).not.toHaveBeenCalled();
        expect(fake.dir(DOCS).get(INVENTORY)).toBe(JSON.stringify(record));
        expect(fake.dir(DOCS).get(QUEUE)).toBe('[]');
        expect(localStorage.getItem(MARKER)).toBeNull();
    });

    it('a getUri that fails is "cannot tell": nothing is deleted and the marker stays off', async () => {
        fake.Filesystem.getUri.mockImplementation(async () => {
            throw new Error('getUri unsupported');
        });
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));

        await init();

        const deletes = fake.Filesystem.deleteFile.mock.calls.map((c) => c[0] as { directory: string });
        expect(deletes.some((d) => d.directory === DOCS)).toBe(false);
        expect(fake.dir(DOCS).get(INVENTORY)).toBe(JSON.stringify(record));
        expect(localStorage.getItem(MARKER)).toBeNull();
    });

    it('asks the platform about the two folders using a real file name, never an empty path', async () => {
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));
        await init();
        const asked = fake.Filesystem.getUri.mock.calls.map((c) => c[0] as { path: string; directory: string });
        expect(asked).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: INVENTORY, directory: DOCS }),
                expect.objectContaining({ path: INVENTORY, directory: LIB }),
            ]),
        );
        expect(asked.some((a) => a.path === '')).toBe(false);
    });

    it('the marker build 102 left behind does not stop the real move, and is cleared by it', async () => {
        localStorage.setItem(STALE_MARKER, '1');
        fake.dir(DOCS).set(INVENTORY, JSON.stringify(record));

        await init();

        expect(fake.dir(LIB).get(INVENTORY)).toBe(JSON.stringify(record));
        expect(fake.dir(DOCS).has(INVENTORY)).toBe(false);
        expect(localStorage.getItem(MARKER)).toBe('1');
        expect(localStorage.getItem(STALE_MARKER)).toBeNull();
    });
});
