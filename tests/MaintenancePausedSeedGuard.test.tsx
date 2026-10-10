/**
 * Pause can never seed the 40 suggested tasks (126-B7a, the R&M seed guard;
 * memory thalassa-binders-live-sync, rail 3: "No auto-seed of the 40 suggested
 * tasks before this account's first full pull on the device, or after its
 * last task is deleted elsewhere").
 *
 * The seed decision counted only ACTIVE tasks. Once Pause ships, an account
 * whose tasks are all paused looks empty on a new phone, and that phone would
 * seed 40 suggestions on top of them, on every device, within seconds.
 *
 * The real chain: the real SyncService and the REAL supabase-js client, with
 * only fetch faked, pull the account's rows into the real LocalDatabase over
 * the in-memory filesystem; the real R&M page decides. The fake PostgREST
 * keeps the rows each phone pushes, so "on every device" is what the server
 * holds. Realtime sockets are left out (useRealtimeSync is a no-op here).
 *
 * Fictional boat 'Kestrel' out of Horta, skipper 'skipper-kestrel'; tasks
 * 'Raw-water impeller', 'Antifouling' and 'Rig inspection'; test.invalid URLs,
 * fake tokens.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };

function base64Url(value: unknown): string {
    return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const h = vi.hoisted(() => {
    const state = {
        storage: new Map<string, string>(),
        /** access token → user id */
        tokens: new Map<string, string>(),
        /** table → id → row: what the server holds */
        tables: new Map<string, Map<string, Row>>(),
        /** every write the server was sent */
        writes: [] as { method: string; table: string; bearer: 'USER' | 'OTHER' }[],
    };
    const json = (status: number, body: unknown) =>
        new Response(body === undefined ? null : JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
        });
    const table = (name: string) => {
        let rows = state.tables.get(name);
        if (!rows) {
            rows = new Map();
            state.tables.set(name, rows);
        }
        return rows;
    };
    /** PostgREST's eq / gt / lte filters, as far as the sync engine uses them. */
    function matches(row: Row, params: URLSearchParams): boolean {
        for (const [key, raw] of params) {
            if (['select', 'order', 'limit', 'offset', 'on_conflict', 'or'].includes(key)) continue;
            const dot = raw.indexOf('.');
            const op = raw.slice(0, dot);
            const expected = raw.slice(dot + 1);
            const actual = String(row[key] ?? '');
            if (op === 'eq' && actual !== expected) return false;
            if (op === 'gt' && !(actual > expected)) return false;
            if (op === 'lte' && !(actual <= expected)) return false;
        }
        return true;
    }

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = (init?.method ?? 'GET').toUpperCase();
        const bearerToken = (new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '');
        const user = state.tokens.get(bearerToken) ?? '';

        if (url.pathname === '/auth/v1/user') {
            if (!user) return json(401, { message: 'invalid JWT' });
            return json(200, {
                id: user,
                aud: 'authenticated',
                role: 'authenticated',
                app_metadata: {},
                user_metadata: {},
                created_at: '2026-01-01T00:00:00.000Z',
            });
        }
        if (url.pathname === '/rest/v1/rpc/get_sync_watermark') return json(200, new Date().toISOString());
        if (!url.pathname.startsWith('/rest/v1/')) return json(404, { message: `unexpected ${url.pathname}` });
        const name = url.pathname.slice('/rest/v1/'.length);
        // Not on this server yet: skipped quietly by the sync engine.
        if (name === 'vessel_engine_hours') {
            return json(404, { code: 'PGRST205', message: "Could not find the table 'public.vessel_engine_hours'" });
        }
        // RLS: a binder table read as anon is empty, with HTTP 200.
        if (!user) return json(method === 'GET' ? 200 : 401, method === 'GET' ? [] : { code: 'PGRST301' });
        const rows = table(name);
        const own = [...rows.values()].filter((row) => row.user_id === undefined || row.user_id === user);

        if (method === 'GET') {
            const found = own
                .filter((row) => matches(row, url.searchParams))
                .sort((a, b) =>
                    String(a.updated_at) === String(b.updated_at)
                        ? a.id.localeCompare(b.id)
                        : String(a.updated_at).localeCompare(String(b.updated_at)),
                );
            const select = url.searchParams.get('select');
            return json(200, select === 'id' ? found.map((row) => ({ id: row.id })) : found);
        }
        state.writes.push({ method, table: name, bearer: user ? 'USER' : 'OTHER' });
        const stamp = new Date().toISOString();
        if (method === 'POST') {
            const body = JSON.parse(String(init?.body ?? '[]')) as Row | Row[];
            for (const row of Array.isArray(body) ? body : [body]) {
                if (!rows.has(row.id)) rows.set(row.id, { ...row, created_at: stamp, updated_at: stamp });
            }
            return json(201, undefined);
        }
        if (method === 'PATCH') {
            const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            const target = own.find((row) => matches(row, url.searchParams));
            if (!target) return json(406, { code: 'PGRST116', message: 'The result contains 0 rows' });
            Object.assign(target, patch, { updated_at: stamp });
            return json(200, { id: target.id });
        }
        return json(500, { message: `unexpected ${method} ${url.pathname}` });
    });

    return { state, fetch, table };
});

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

// The in-memory filesystem, plus a listing of a folder's root (path ''), which
// the database reads to find its files and the shared helper does not answer.
vi.mock('@capacitor/filesystem', async () => {
    const { memoryFilesystemModule, memoryFs: fs } = await import('./helpers/memoryFilesystem');
    const module = memoryFilesystemModule();
    const readdir: typeof fs.readdir = async (options) => {
        if (options.path) return fs.readdir(options);
        const root = `${options.directory ?? 'DATA'}/`;
        const files = [...fs.files.entries()]
            .filter(([key]) => key.startsWith(root) && !key.slice(root.length).includes('/'))
            .map(([key, file]) => ({
                name: key.slice(root.length),
                type: 'file' as const,
                size: file.data.length,
                ctime: file.mtime,
                mtime: file.mtime,
                uri: `mem://${key}`,
            }));
        return { files };
    };
    return { ...module, Filesystem: { ...fs, readdir } };
});

// The share snapshot is set by each test; the cycle must not fetch another.
vi.mock('../services/vessel/sharedBinders', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/vessel/sharedBinders')>()),
    refreshSharedBinders: vi.fn(async () => ({ changed: false, fresh: true })),
}));
vi.mock('../services/CrewService', () => ({ getMyCrew: vi.fn(async () => []) }));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
vi.mock('../services/MaintenancePdfService', () => ({ exportChecklist: vi.fn(), exportServiceHistory: vi.fn() }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Kestrel' } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { memoryFs } from './helpers/memoryFilesystem';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { getFullQueue, initLocalDatabase } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { syncNow } from '../services/vessel/SyncService';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';

const SKIPPER = 'skipper-kestrel';
/** Long enough ago that every pull window includes it. */
const SERVER_STAMP = '2026-09-01T00:00:00.000Z';

function serverTask(id: string, title: string, isActive: boolean, category = 'Engine'): Row {
    return {
        id,
        user_id: SKIPPER,
        title,
        description: null,
        category,
        trigger_type: 'monthly',
        interval_value: 30,
        next_due_date: '2026-11-01',
        next_due_hours: null,
        last_completed: '2026-10-01T08:00:00.000Z',
        is_active: isActive,
        created_at: SERVER_STAMP,
        updated_at: SERVER_STAMP,
    };
}

function storeSession(userId: string): void {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = [
        base64Url({ alg: 'HS256', typ: 'JWT' }),
        base64Url({ sub: userId, role: 'authenticated', aud: 'authenticated', exp: expiresAt }),
        'test-signature',
    ].join('.');
    h.state.tokens.set(token, userId);
    h.state.storage.set(
        'test-auth',
        JSON.stringify({
            access_token: token,
            refresh_token: `refresh-${userId}`,
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: expiresAt,
            user: {
                id: userId,
                aud: 'authenticated',
                role: 'authenticated',
                app_metadata: {},
                user_metadata: {},
                created_at: '2026-01-01T00:00:00.000Z',
            },
        }),
    );
}

/**
 * A phone this account has never used R&M on: an empty local database, no
 * seed or had-tasks marker, its crew shares confirmed (none), and no pull yet.
 */
async function newPhone(): Promise<void> {
    await act(async () => {
        setAuthIdentityScope(null);
        await initLocalDatabase(null);
    });
    memoryFs.reset();
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    act(() => setAuthIdentityScope(SKIPPER));
    storeSession(SKIPPER);
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({ version: 1, userId: SKIPPER, confirmedAt: SERVER_STAMP, skippers: [] }),
    );
    act(() => reloadSharedBindersFromStorage());
    await initLocalDatabase(SKIPPER);
}

async function syncCycle(): Promise<void> {
    await act(async () => {
        const result = await syncNow();
        expect(result.errors).toEqual([]);
    });
}

async function settle(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
    });
}

const queuedTaskInserts = () =>
    getFullQueue().filter((item) => item.table_name === 'maintenance_tasks' && item.mutation_type === 'INSERT');

beforeEach(() => {
    h.state.storage.clear();
    h.state.tokens.clear();
    h.state.tables.clear();
    h.state.writes = [];
});

afterEach(async () => {
    await act(async () => {
        setAuthIdentityScope(null);
        await initLocalDatabase(null);
    });
    localStorage.clear();
});

describe('R&M on a new phone, with the real supabase-js client', () => {
    it('an account whose tasks are all paused: the first full pull brings them in, and nothing is seeded', async () => {
        h.table('maintenance_tasks').set('t-impeller', serverTask('t-impeller', 'Raw-water impeller', false));
        h.table('maintenance_tasks').set('t-antifoul', serverTask('t-antifoul', 'Antifouling', false, 'Hull'));
        await newPhone();
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('No maintenance tasks');

        // The first full pull, over the real client.
        await syncCycle();
        await settle();

        expect(queuedTaskInserts()).toHaveLength(0);
        expect(await screen.findByRole('button', { name: 'Paused (2)' })).toBeInTheDocument();
        expect(screen.queryByText('No maintenance tasks')).not.toBeInTheDocument();
        // Nothing went to the server either: every device still has two tasks.
        await syncCycle();
        expect(h.state.writes.filter((write) => write.table === 'maintenance_tasks')).toEqual([]);
        expect(h.table('maintenance_tasks').size).toBe(2);
    });

    it('pausing the last active task on one phone seeds nothing there, nor on the next phone', async () => {
        h.table('maintenance_tasks').set('t-rig', serverTask('t-rig', 'Rig inspection', true, 'Rigging'));

        // Phone one: the task arrives, the skipper pauses it, the change goes up.
        await newPhone();
        const first = render(<MaintenanceHub onBack={vi.fn()} />);
        await syncCycle();
        fireEvent.click(await screen.findByRole('button', { name: 'Options for Rig inspection' }));
        const sheet = await screen.findByRole('dialog', { name: 'Rig inspection' });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Pause' }));
        expect(await screen.findByRole('button', { name: 'Paused (1)' })).toBeInTheDocument();
        await syncCycle();
        expect(h.table('maintenance_tasks').get('t-rig')?.is_active).toBe(false);
        expect(h.state.writes).toContainEqual({ method: 'PATCH', table: 'maintenance_tasks', bearer: 'USER' });
        await settle();
        expect(queuedTaskInserts()).toEqual([]);
        first.unmount();

        // Phone two: a reinstall, or the iPad.
        await newPhone();
        render(<MaintenanceHub onBack={vi.fn()} />);
        await syncCycle();
        expect(await screen.findByRole('button', { name: 'Paused (1)' })).toBeInTheDocument();
        await settle();
        await syncCycle();

        expect(queuedTaskInserts()).toEqual([]);
        expect(
            h.state.writes.filter((write) => write.method === 'POST' && write.table === 'maintenance_tasks'),
        ).toEqual([]);
        expect([...h.table('maintenance_tasks').keys()]).toEqual(['t-rig']);
    });
});
