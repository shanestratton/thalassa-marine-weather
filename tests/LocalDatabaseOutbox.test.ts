import { Filesystem } from '@capacitor/filesystem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type LocalDatabaseModule = typeof import('../services/vessel/LocalDatabase');

interface InventoryTestRecord {
    id: string;
    item_name: string;
    quantity: number;
    updated_at?: string;
}

interface ShoppingTestRecord {
    id: string;
    ingredient_name: string;
    purchased: boolean;
    updated_at?: string;
}

async function loadDatabase(identity: string | null = 'user-a'): Promise<LocalDatabaseModule> {
    const database = await import('../services/vessel/LocalDatabase');
    await database.initLocalDatabase(identity);
    return database;
}

function scopedFile(identity: string | null, legacyFile: string): string {
    const token = identity
        ? `user_${Array.from(new TextEncoder().encode(identity), (byte) => byte.toString(16).padStart(2, '0')).join(
              '',
          )}`
        : 'anonymous';
    return `vessel_${token}_${legacyFile.replace(/^vessel_/, '')}`;
}

describe('LocalDatabase durable outbox', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        localStorage.clear();
        vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
        vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
        vi.mocked(Filesystem.rename).mockResolvedValue();
    });

    it('shares concurrent initialization and rejects a storage read failure', async () => {
        vi.mocked(Filesystem.readdir)
            .mockRejectedValueOnce(new Error('documents unavailable'))
            .mockResolvedValue({ files: [] });
        const database = await import('../services/vessel/LocalDatabase');

        const first = database.initLocalDatabase();
        const second = database.initLocalDatabase();
        expect(second).toBe(first);
        await expect(first).rejects.toThrow('documents unavailable');

        await expect(database.initLocalDatabase()).resolves.toBeUndefined();
    });

    it('preserves creation, updates, and every delta in per-record order', async () => {
        const database = await loadDatabase();
        const inserted = database.insertLocal('inventory_items', {
            id: 'stores-1',
            item_name: 'Water',
            quantity: 5,
        });
        const updated = database.updateLocal<InventoryTestRecord>('inventory_items', 'stores-1', {
            item_name: 'Drinking water',
        });

        await Promise.all([inserted, updated]);
        await database.deltaLocal('inventory_items', 'stores-1', 'quantity', -1.5);
        await database.deltaLocal('inventory_items', 'stores-1', 'quantity', -0.5);
        await database.deleteLocal('inventory_items', 'stores-1');

        const queue = database.getFullQueue();
        expect(queue.map((item) => item.mutation_type)).toEqual(['INSERT', 'UPDATE', 'DELTA', 'DELTA', 'DELETE']);
        expect(queue.map((item) => item.record_id)).toEqual(Array(5).fill('stores-1'));
        expect(JSON.parse(queue[1].payload)).toMatchObject({ item_name: 'Drinking water' });
        expect(JSON.parse(queue[1].payload)).not.toHaveProperty('quantity');
        expect(JSON.parse(queue[2].payload)).toMatchObject({ field: 'quantity', delta: -1.5 });
        expect(JSON.parse(queue[3].payload)).toMatchObject({ field: 'quantity', delta: -0.5 });
        expect(database.getById('inventory_items', 'stores-1')).toBeNull();
    });

    it('serializes concurrent deltas without losing local or queued changes', async () => {
        const database = await loadDatabase();
        await database.bulkUpsert('inventory_items', [{ id: 'stores-2', quantity: 10 }]);

        await Promise.all([
            database.deltaLocal('inventory_items', 'stores-2', 'quantity', -1),
            database.deltaLocal('inventory_items', 'stores-2', 'quantity', -2),
            database.deltaLocal('inventory_items', 'stores-2', 'quantity', 4),
        ]);

        expect(database.getById<{ quantity: number }>('inventory_items', 'stores-2')?.quantity).toBe(11);
        expect(database.getFullQueue().map((item) => JSON.parse(item.payload).delta)).toEqual([-1, -2, 4]);
    });

    it('rejects a persistence failure without exposing an uncommitted mutation', async () => {
        const database = await loadDatabase();
        vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path }) => {
            if (path.includes('_inventory_items.json')) {
                throw new Error('disk full');
            }
            return { uri: 'mock://file' };
        });

        await expect(
            database.insertLocal('inventory_items', {
                id: 'stores-failed',
                item_name: 'Flour',
                quantity: 2,
            }),
        ).rejects.toThrow('disk full');

        expect(database.getById('inventory_items', 'stores-failed')).toBeNull();
        expect(database.getFullQueue()).toEqual([]);
    });

    it('does not let a pull overwrite a record with any outstanding outbox item', async () => {
        const database = await loadDatabase();
        await database.bulkUpsert('inventory_items', [
            {
                id: 'dirty-stores',
                item_name: 'Rice',
                quantity: 4,
                updated_at: '2026-07-23T10:00:00.000Z',
            },
            {
                id: 'clean-stores',
                item_name: 'Beans',
                quantity: 1,
                updated_at: '2026-07-23T10:00:00.000Z',
            },
        ]);
        await database.deltaLocal('inventory_items', 'dirty-stores', 'quantity', -1);

        const merged = await database.mergePulledRecords('inventory_items', [
            {
                id: 'dirty-stores',
                item_name: 'Rice',
                quantity: 99,
                updated_at: '2026-07-23T11:00:00.000Z',
            },
            {
                id: 'clean-stores',
                item_name: 'Beans',
                quantity: 3,
                updated_at: '2026-07-23T11:00:00.000Z',
            },
        ]);

        expect(merged).toBe(1);
        expect(database.getById<{ quantity: number }>('inventory_items', 'dirty-stores')?.quantity).toBe(3);
        expect(database.getById<{ quantity: number }>('inventory_items', 'clean-stores')?.quantity).toBe(3);
    });

    it('prunes revoked clean rows during a full snapshot while preserving dirty intent', async () => {
        const database = await loadDatabase();
        await database.bulkUpsert('inventory_items', [
            { id: 'revoked-clean', item_name: 'No longer visible', quantity: 1 },
            { id: 'dirty-local', item_name: 'Pending local edit', quantity: 2 },
        ]);
        await database.updateLocal<InventoryTestRecord>('inventory_items', 'dirty-local', { quantity: 3 });

        await expect(database.prunePulledTable('inventory_items', new Set())).resolves.toBe(1);
        expect(database.getById('inventory_items', 'revoked-clean')).toBeNull();
        expect(database.getById('inventory_items', 'dirty-local')).toMatchObject({ quantity: 3 });
    });

    it('never terminally strands failed operations at the old retry cap', async () => {
        const database = await loadDatabase();
        await database.insertLocal('inventory_items', {
            id: 'retry-forever',
            item_name: 'Durable intent',
            quantity: 1,
        });
        const operationId = database.getFullQueue()[0].id;
        for (let attempt = 0; attempt < 7; attempt += 1) {
            await database.markFailed([operationId], `temporary failure ${attempt}`);
        }

        expect(database.getFullQueue()[0]).toMatchObject({
            status: 'failed',
            retry_count: 7,
        });
        expect(database.getFailedCount()).toBe(1);

        await database.retryFailed();
        expect(database.getFullQueue()[0]).toMatchObject({
            status: 'pending',
            retry_count: 7,
        });
        expect(database.getFailedCount()).toBe(0);
    });

    it('applies realtime updates and deletes while fencing dirty local records', async () => {
        const database = await loadDatabase();
        await database.bulkUpsert('shopping_list', [
            {
                id: 'remote-item',
                ingredient_name: 'Rice',
                purchased: false,
                updated_at: '2026-07-23T10:00:00.000Z',
            },
            {
                id: 'dirty-item',
                ingredient_name: 'Beans',
                purchased: false,
                updated_at: '2026-07-23T10:00:00.000Z',
            },
        ]);
        await database.updateLocal<ShoppingTestRecord>('shopping_list', 'dirty-item', { purchased: true });

        await expect(
            database.applyRealtimeChange('shopping_list', 'UPDATE', {
                id: 'remote-item',
                ingredient_name: 'Rice',
                purchased: true,
                updated_at: '2026-07-23T11:00:00.000Z',
            }),
        ).resolves.toBe(true);
        await expect(
            database.applyRealtimeChange('shopping_list', 'DELETE', {
                id: 'dirty-item',
            }),
        ).resolves.toBe(false);
        await expect(
            database.applyRealtimeChange('shopping_list', 'DELETE', {
                id: 'remote-item',
            }),
        ).resolves.toBe(true);

        expect(database.getById('shopping_list', 'remote-item')).toBeNull();
        expect(database.getById<{ purchased: boolean }>('shopping_list', 'dirty-item')?.purchased).toBe(true);
    });

    it('rejects a realtime row captured for an earlier database identity', async () => {
        const database = await loadDatabase('account-a');
        const accountASession = database.getLocalDatabaseSession();

        await database.initLocalDatabase('account-b');
        await expect(
            database.applyRealtimeChange(
                'shopping_list',
                'UPDATE',
                {
                    id: 'account-a-private-row',
                    ingredient_name: 'A only',
                    purchased: true,
                },
                accountASession,
            ),
        ).resolves.toBe(false);

        expect(database.getById('shopping_list', 'account-a-private-row')).toBeNull();
    });

    it('replays an outbox-first delta after a crash without double-applying it', async () => {
        const inventoryFile = scopedFile('user-a', 'vessel_inventory_items.json');
        const queueFile = scopedFile('user-a', 'vessel_sync_queue.json');
        const files = [inventoryFile, queueFile];
        vi.mocked(Filesystem.readdir).mockResolvedValue({
            files: files.map((name) => ({
                name,
                type: 'file',
                size: 0,
                ctime: 0,
                mtime: 0,
                uri: `mock://${name}`,
            })),
        });
        vi.mocked(Filesystem.readFile).mockImplementation(async ({ path }) => {
            if (path === inventoryFile) {
                return {
                    data: JSON.stringify({
                        'stores-crash': {
                            id: 'stores-crash',
                            item_name: 'Water',
                            quantity: 5,
                            updated_at: '2026-07-23T10:00:00.000Z',
                        },
                    }),
                };
            }
            if (path === queueFile) {
                return {
                    data: JSON.stringify([
                        {
                            id: 'delta-crash-op',
                            table_name: 'inventory_items',
                            record_id: 'stores-crash',
                            mutation_type: 'DELTA',
                            payload: JSON.stringify({
                                id: 'stores-crash',
                                field: 'quantity',
                                delta: -2,
                                local_value: 3,
                                updated_at: '2026-07-23T11:00:00.000Z',
                            }),
                            created_at: '2026-07-23T11:00:00.000Z',
                            status: 'syncing',
                            retry_count: 0,
                            owner_user_id: 'user-a',
                        },
                    ]),
                };
            }
            return { data: '{}' };
        });

        const database = await loadDatabase();

        expect(database.getById<{ quantity: number }>('inventory_items', 'stores-crash')?.quantity).toBe(3);
        expect(database.getFullQueue()[0]).toMatchObject({
            id: 'delta-crash-op',
            status: 'pending',
        });

        // Replaying again would assign local_value=3, not subtract another 2.
        const repairedWrite = vi
            .mocked(Filesystem.writeFile)
            .mock.calls.find(([options]) => options.path === `${inventoryFile}.tmp`);
        expect(repairedWrite?.[0].data).toContain('"quantity":3');
    });

    it('recovers a valid backup after an interrupted atomic file swap', async () => {
        const inventoryFile = scopedFile('user-a', 'vessel_inventory_items.json');
        const disk = new Map<string, string>([
            [
                `${inventoryFile}.bak`,
                JSON.stringify({
                    recovered: {
                        id: 'recovered',
                        item_name: 'Emergency water',
                        quantity: 8,
                    },
                }),
            ],
            [`${inventoryFile}.tmp`, '{"truncated":'],
        ]);
        vi.mocked(Filesystem.readdir).mockImplementation(async () => ({
            files: Array.from(disk.keys()).map((name) => ({
                name,
                type: 'file',
                size: disk.get(name)?.length ?? 0,
                ctime: 0,
                mtime: 0,
                uri: `mock://${name}`,
            })),
        }));
        vi.mocked(Filesystem.readFile).mockImplementation(async ({ path }) => ({
            data: disk.get(path) ?? '',
        }));
        vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
            disk.set(path, String(data));
            return { uri: `mock://${path}` };
        });
        vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
            disk.delete(path);
        });
        vi.mocked(Filesystem.rename).mockImplementation(async ({ from, to }) => {
            const contents = disk.get(from);
            if (contents === undefined) throw new Error(`Missing ${from}`);
            disk.set(to, contents);
            disk.delete(from);
        });

        const database = await loadDatabase('user-a');

        expect(database.getById('inventory_items', 'recovered')).toMatchObject({
            item_name: 'Emergency water',
            quantity: 8,
        });
        expect(JSON.parse(disk.get(inventoryFile) || '{}')).toHaveProperty('recovered');
    });

    it('does not reject a committed write when stale-backup cleanup fails', async () => {
        const disk = new Map<string, string>();
        vi.mocked(Filesystem.readdir).mockImplementation(async () => ({
            files: Array.from(disk.keys()).map((name) => ({
                name,
                type: 'file',
                size: disk.get(name)?.length ?? 0,
                ctime: 0,
                mtime: 0,
                uri: `mock://${name}`,
            })),
        }));
        vi.mocked(Filesystem.readFile).mockImplementation(async ({ path }) => ({
            data: disk.get(path) ?? '',
        }));
        vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
            disk.set(path, String(data));
            return { uri: `mock://${path}` };
        });
        vi.mocked(Filesystem.rename).mockImplementation(async ({ from, to }) => {
            const contents = disk.get(from);
            if (contents === undefined) throw new Error(`Missing ${from}`);
            disk.set(to, contents);
            disk.delete(from);
        });
        vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
            if (path.endsWith('.bak')) throw new Error('backup cleanup interrupted');
            disk.delete(path);
        });

        const database = await loadDatabase('user-a');
        await database.bulkUpsert('inventory_items', [{ id: 'water', quantity: 1 }]);
        await expect(database.bulkUpsert('inventory_items', [{ id: 'water', quantity: 2 }])).resolves.toBeUndefined();

        const inventoryFile = scopedFile('user-a', 'vessel_inventory_items.json');
        expect(JSON.parse(disk.get(inventoryFile) || '{}').water).toMatchObject({ quantity: 2 });
        expect(disk.has(`${inventoryFile}.bak`)).toBe(true);
    });

    it('atomically switches cache, queue, files, and cursors between accounts', async () => {
        const disk = new Map<string, string>();
        vi.mocked(Filesystem.readdir).mockImplementation(async () => ({
            files: Array.from(disk.keys()).map((name) => ({
                name,
                type: 'file',
                size: disk.get(name)?.length ?? 0,
                ctime: 0,
                mtime: 0,
                uri: `mock://${name}`,
            })),
        }));
        vi.mocked(Filesystem.readFile).mockImplementation(async ({ path }) => ({
            data: disk.get(path) ?? '',
        }));
        vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
            disk.set(path, String(data));
            return { uri: `mock://${path}` };
        });
        vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
            disk.delete(path);
        });
        vi.mocked(Filesystem.rename).mockImplementation(async ({ from, to }) => {
            const contents = disk.get(from);
            if (contents === undefined) throw new Error(`Missing ${from}`);
            disk.set(to, contents);
            disk.delete(from);
        });

        const database = await import('../services/vessel/LocalDatabase');
        await database.initLocalDatabase('account-a');
        await database.insertLocal('inventory_items', {
            id: 'private-a',
            item_name: 'A only',
            quantity: 1,
        });
        await database.updateSyncMeta({ lastPullTimestamp: '2026-07-23T10:00:00.000Z' });

        const switching = database.initLocalDatabase('account-b');
        expect(() => database.getAll('inventory_items')).toThrow('Not initialized');
        await switching;

        expect(database.getAll('inventory_items')).toEqual([]);
        expect(database.getFullQueue()).toEqual([]);
        expect(database.getSyncMeta().lastPullTimestamp).toBeNull();
        await database.insertLocal('inventory_items', {
            id: 'private-b',
            item_name: 'B only',
            quantity: 2,
        });

        await database.initLocalDatabase('account-a');
        expect(database.getAll<{ id: string }>('inventory_items').map((item) => item.id)).toEqual(['private-a']);
        expect(database.getFullQueue()).toEqual([
            expect.objectContaining({
                record_id: 'private-a',
                owner_user_id: 'account-a',
            }),
        ]);
        expect(database.getSyncMeta()).toMatchObject({
            ownerUserId: 'account-a',
            lastPullTimestamp: '2026-07-23T10:00:00.000Z',
        });

        await database.initLocalDatabase('account-b');
        expect(database.getAll<{ id: string }>('inventory_items').map((item) => item.id)).toEqual(['private-b']);
        expect(database.getFullQueue()[0]).toMatchObject({
            record_id: 'private-b',
            owner_user_id: 'account-b',
        });
    });

    it('adopts browse-mode work once without exposing it to the next account', async () => {
        const disk = new Map<string, string>();
        vi.mocked(Filesystem.readdir).mockImplementation(async () => ({
            files: Array.from(disk.keys()).map((name) => ({
                name,
                type: 'file',
                size: disk.get(name)?.length ?? 0,
                ctime: 0,
                mtime: 0,
                uri: `mock://${name}`,
            })),
        }));
        vi.mocked(Filesystem.readFile).mockImplementation(async ({ path }) => ({
            data: disk.get(path) ?? '',
        }));
        vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
            disk.set(path, String(data));
            return { uri: `mock://${path}` };
        });
        vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
            disk.delete(path);
        });
        vi.mocked(Filesystem.rename).mockImplementation(async ({ from, to }) => {
            const contents = disk.get(from);
            if (contents === undefined) throw new Error(`Missing ${from}`);
            disk.set(to, contents);
            disk.delete(from);
        });

        const database = await import('../services/vessel/LocalDatabase');
        await database.initLocalDatabase(null);
        await database.insertLocal('shopping_list', {
            id: 'browse-item',
            ingredient_name: 'Fresh bread',
            purchased: false,
        });

        await database.initLocalDatabase('account-a');
        expect(database.getById('shopping_list', 'browse-item')).toMatchObject({
            ingredient_name: 'Fresh bread',
        });
        expect(database.getFullQueue()[0]).toMatchObject({
            record_id: 'browse-item',
            owner_user_id: 'account-a',
        });

        // Simulate stale recovery copies left around the claim tombstone.
        const claimFile = 'vessel_anonymous_scope_claim.json';
        const persistedClaim = disk.get(claimFile);
        expect(persistedClaim).toBeTruthy();
        disk.set(`${claimFile}.tmp`, persistedClaim!);
        disk.set(`${claimFile}.bak`, persistedClaim!);

        // Returning to browse mode resets the successfully adopted handoff and
        // removes every recovery copy so the old account cannot be resurrected.
        await database.initLocalDatabase(null);
        expect(database.getAll('shopping_list')).toEqual([]);
        expect(database.getFullQueue()).toEqual([]);
        expect([...disk.keys()].filter((path) => path.startsWith(claimFile))).toEqual([]);

        await database.insertLocal('shopping_list', {
            id: 'second-browse-item',
            ingredient_name: 'Account B bread',
            purchased: false,
        });

        await database.initLocalDatabase('account-b');
        expect(database.getById('shopping_list', 'browse-item')).toBeNull();
        expect(database.getById('shopping_list', 'second-browse-item')).toMatchObject({
            ingredient_name: 'Account B bread',
        });
        expect(database.getFullQueue()[0]).toMatchObject({
            record_id: 'second-browse-item',
            owner_user_id: 'account-b',
        });
    });

    it('quarantines ambiguous legacy global data instead of guessing its account', async () => {
        const legacyInventory = 'vessel_inventory_items.json';
        const disk = new Map<string, string>([
            [
                legacyInventory,
                JSON.stringify({
                    ambiguous: {
                        id: 'ambiguous',
                        item_name: 'Unknown owner',
                        quantity: 3,
                        user_id: '',
                    },
                }),
            ],
        ]);
        vi.mocked(Filesystem.readdir).mockImplementation(async () => ({
            files: Array.from(disk.keys()).map((name) => ({
                name,
                type: 'file',
                size: disk.get(name)?.length ?? 0,
                ctime: 0,
                mtime: 0,
                uri: `mock://${name}`,
            })),
        }));
        vi.mocked(Filesystem.readFile).mockImplementation(async ({ path }) => ({
            data: disk.get(path) ?? '',
        }));
        vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
            disk.set(path, String(data));
            return { uri: `mock://${path}` };
        });
        vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
            disk.delete(path);
        });
        vi.mocked(Filesystem.rename).mockImplementation(async ({ from, to }) => {
            const contents = disk.get(from);
            if (contents === undefined) throw new Error(`Missing ${from}`);
            disk.set(to, contents);
            disk.delete(from);
        });

        const database = await import('../services/vessel/LocalDatabase');
        await database.initLocalDatabase('account-a');
        expect(database.getAll('inventory_items')).toEqual([]);

        await database.initLocalDatabase('account-b');
        expect(database.getAll('inventory_items')).toEqual([]);
        expect(JSON.parse(disk.get('vessel_legacy_scope_claim.json') || '{}')).toMatchObject({
            state: 'quarantined',
            ownerUserId: null,
        });
        // Original bytes remain recoverable for an explicit future export.
        expect(disk.has(legacyInventory)).toBe(true);
    });
});
