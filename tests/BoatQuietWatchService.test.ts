/**
 * What Preferences reads and writes for the quiet-boat watch (129-08).
 *
 * The skipper's switch shows only once a column probe of 125-11's table
 * answers (vessel_quiet_watch, 20261009150000): a read that fails, or does not
 * answer in time, hides it. With no row yet it shows only for an account whose
 * Pi reports to the cloud: a watch with no Pi could never page. The crew's
 * switches come from vessel_quiet_watch_crew_boats(), a call the held
 * migration adds: until it answers, there are none, and the line says 125's
 * watchdog (crewPaging false). The skipper's switch updates, else inserts,
 * never upserts: 125 grants UPDATE on the switch and window, not owner_id.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = { data: unknown; error: unknown };
type Call = { op: string; table: string; args: unknown[] };
const db = vi.hoisted(() => ({
    answers: new Map<string, Answer | 'hang' | (Answer | 'hang')[]>(),
    calls: [] as Call[],
    configured: true,
}));

/** The next answer for a key: a list is used up in order, its last repeating. */
function answer(key: string): Promise<Answer> {
    const queued = db.answers.get(key);
    const a = Array.isArray(queued) ? (queued.length > 1 ? queued.shift() : queued[0]) : queued;
    if (a === 'hang') return new Promise(() => undefined);
    return Promise.resolve(a ?? { data: [], error: null });
}

vi.mock('../services/supabase', () => {
    /**
     * PostgREST's builder, as far as this service uses it: every call is
     * recorded, and the request answers (by its verb and table) when awaited.
     */
    const query = (table: string) => {
        let verb = 'select';
        const chain = {
            select: (...args: unknown[]) => {
                db.calls.push({ op: 'select', table, args });
                return chain;
            },
            eq: (...args: unknown[]) => {
                db.calls.push({ op: 'eq', table, args });
                return chain;
            },
            limit: () => answer(`select:${table}`),
            update: (...args: unknown[]) => {
                verb = 'update';
                db.calls.push({ op: 'update', table, args });
                return chain;
            },
            insert: (...args: unknown[]) => {
                verb = 'insert';
                db.calls.push({ op: 'insert', table, args });
                return chain;
            },
            upsert: (...args: unknown[]) => {
                verb = 'upsert';
                db.calls.push({ op: 'upsert', table, args });
                return chain;
            },
            then: (resolve: (a: Answer) => unknown, reject?: (e: unknown) => unknown) =>
                answer(`${verb}:${table}`).then(resolve, reject),
        };
        return chain;
    };
    const client = {
        from: (table: string) => query(table),
        rpc: (name: string, args?: unknown) => {
            db.calls.push({ op: 'rpc', table: name, args: [args] });
            return answer(`rpc:${name}`);
        },
    };
    return {
        get supabase() {
            return db.configured ? client : null;
        },
    };
});

import {
    QUIET_PROBE_TIMEOUT_MS,
    loadQuietWatch,
    saveOwnerQuietWatch,
    setCrewQuietPage,
} from '../services/boatQuiet/quietWatchService';

const SKIPPER = '00000000-0000-4000-8000-000000000129';
const missingTable = {
    data: null,
    error: { code: 'PGRST205', message: "Could not find the table 'public.vessel_quiet_watch'" },
};
const missingFunction = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };

beforeEach(() => {
    db.answers.clear();
    db.calls = [];
    db.configured = true;
});
afterEach(() => vi.useRealTimers());

describe('the column probe and the read', () => {
    it('the table not there: no switch for the skipper; the crew call not there: none for crew', async () => {
        db.answers.set('select:vessel_quiet_watch', missingTable);
        db.answers.set('rpc:vessel_quiet_watch_crew_boats', missingFunction);
        expect(await loadQuietWatch(SKIPPER)).toEqual({ owner: null, crew: [], crewPaging: false });
    });

    it('the crew call answering, even with no boats, is the 129-08 watchdog; not there is 125’s', async () => {
        db.answers.set('select:vessel_quiet_watch', { data: [], error: null });
        db.answers.set('select:vessel_telemetry', { data: [{ source: 'pi' }], error: null });
        db.answers.set('rpc:vessel_quiet_watch_crew_boats', { data: [], error: null });
        expect(await loadQuietWatch(SKIPPER)).toMatchObject({ crew: [], crewPaging: true });
        db.answers.set('rpc:vessel_quiet_watch_crew_boats', missingFunction);
        expect(await loadQuietWatch(SKIPPER)).toMatchObject({ crew: [], crewPaging: false });
    });

    it('probes the very columns the switch writes, for this account only', async () => {
        db.answers.set('select:vessel_quiet_watch', { data: [], error: null });
        await loadQuietWatch(SKIPPER);
        expect(db.calls).toContainEqual({
            op: 'select',
            table: 'vessel_quiet_watch',
            args: ['owner_id,enabled,quiet_after_minutes,window_dow,window_start,window_end,window_tz'],
        });
        expect(db.calls).toContainEqual({ op: 'eq', table: 'vessel_quiet_watch', args: ['owner_id', SKIPPER] });
    });

    it('her row: on, its grace and its window in her own zone', async () => {
        db.answers.set('select:vessel_quiet_watch', {
            data: [
                {
                    owner_id: SKIPPER,
                    enabled: true,
                    quiet_after_minutes: 15,
                    window_dow: 3,
                    window_start: '19:30:00',
                    window_end: '19:50:00',
                    window_tz: 'Pacific/Auckland',
                },
            ],
            error: null,
        });
        const view = await loadQuietWatch(SKIPPER);
        expect(view.owner).toEqual({
            enabled: true,
            graceMin: 15,
            window: { dow: 3, start: '19:30', end: '19:50', tz: 'Pacific/Auckland' },
        });
    });

    it('no row yet: offered (off) only when her Pi reports to the cloud', async () => {
        db.answers.set('select:vessel_quiet_watch', { data: [], error: null });
        db.answers.set('select:vessel_telemetry', { data: [{ source: 'pi' }], error: null });
        expect((await loadQuietWatch(SKIPPER)).owner).toEqual({ enabled: false, graceMin: 15, window: null });
        db.answers.set('select:vessel_telemetry', { data: [{ source: 'device' }], error: null });
        expect((await loadQuietWatch(SKIPPER)).owner).toBeNull();
        db.answers.set('select:vessel_telemetry', { data: [], error: null });
        expect((await loadQuietWatch(SKIPPER)).owner).toBeNull();
    });

    it('a probe that does not answer in time hides the switch, it never waits for ever', async () => {
        vi.useFakeTimers();
        db.answers.set('select:vessel_quiet_watch', 'hang');
        db.answers.set('rpc:vessel_quiet_watch_crew_boats', 'hang');
        const pending = loadQuietWatch(SKIPPER);
        await vi.advanceTimersByTimeAsync(QUIET_PROBE_TIMEOUT_MS + 10);
        expect(await pending).toEqual({ owner: null, crew: [], crewPaging: false });
    });

    it('the boats this account crews, with names in any script', async () => {
        db.answers.set('select:vessel_quiet_watch', missingTable);
        db.answers.set('rpc:vessel_quiet_watch_crew_boats', {
            data: [
                { owner_id: 'o-1', boat_name: 'Αύρα', watch_on: true, paging_me: true },
                { owner_id: 'o-2', boat_name: null, watch_on: false, paging_me: false },
                { owner_id: 42, boat_name: 'not a row' },
            ],
            error: null,
        });
        expect((await loadQuietWatch(SKIPPER)).crew).toEqual([
            { ownerId: 'o-1', boatName: 'Αύρα', watchOn: true, pagingMe: true },
            { ownerId: 'o-2', boatName: null, watchOn: false, pagingMe: false },
        ]);
    });

    it('no backend at all: nothing', async () => {
        db.configured = false;
        expect(await loadQuietWatch(SKIPPER)).toEqual({ owner: null, crew: [], crewPaging: false });
        expect(await saveOwnerQuietWatch(SKIPPER, true, { dow: 3, start: '19:30', end: '19:50', tz: 'UTC' })).toBe(
            'failed',
        );
        expect(await setCrewQuietPage('o-1', false)).toBe('failed');
    });
});

describe('the writes', () => {
    const lisbon = { dow: 3, start: '19:30', end: '19:50', tz: 'Europe/Lisbon' };
    const settings = {
        enabled: true,
        window_dow: 3,
        window_start: '19:30',
        window_end: '19:50',
        window_tz: 'Europe/Lisbon',
    };
    const writes = () => db.calls.filter((c) => ['update', 'insert', 'upsert'].includes(c.op));

    it('her row there: one UPDATE of the switch and window, by owner_id, never owner_id in its SET', async () => {
        db.answers.set('update:vessel_quiet_watch', { data: [{ owner_id: SKIPPER }], error: null });
        expect(await saveOwnerQuietWatch(SKIPPER, true, lisbon)).toBe('saved');
        expect(writes()).toEqual([{ op: 'update', table: 'vessel_quiet_watch', args: [settings] }]);
        expect(db.calls).toContainEqual({ op: 'eq', table: 'vessel_quiet_watch', args: ['owner_id', SKIPPER] });
    });

    it('no row yet: the update finds none, so it inserts hers, owner_id and all', async () => {
        db.answers.set('update:vessel_quiet_watch', { data: [], error: null });
        db.answers.set('insert:vessel_quiet_watch', { data: null, error: null });
        expect(await saveOwnerQuietWatch(SKIPPER, true, lisbon)).toBe('saved');
        expect(writes()).toEqual([
            { op: 'update', table: 'vessel_quiet_watch', args: [settings] },
            { op: 'insert', table: 'vessel_quiet_watch', args: [{ owner_id: SKIPPER, ...settings }] },
        ]);
    });

    it('another device inserted it first (23505): it updates again', async () => {
        db.answers.set('update:vessel_quiet_watch', [
            { data: [], error: null },
            { data: [{ owner_id: SKIPPER }], error: null },
        ]);
        db.answers.set('insert:vessel_quiet_watch', {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        });
        expect(await saveOwnerQuietWatch(SKIPPER, false, lisbon)).toBe('saved');
        expect(writes().map((c) => c.op)).toEqual(['update', 'insert', 'update']);
    });

    it('never an upsert, and no UPDATE ever sets owner_id: 125 grants UPDATE on the switch and window only', async () => {
        for (const update of [
            { data: [{ owner_id: SKIPPER }], error: null },
            { data: [], error: null },
        ]) {
            db.calls = [];
            db.answers.set('update:vessel_quiet_watch', update);
            await saveOwnerQuietWatch(SKIPPER, true, lisbon);
            expect(db.calls.some((c) => c.op === 'upsert')).toBe(false);
            for (const c of db.calls.filter((call) => call.op === 'update')) {
                expect(Object.keys(c.args[0] as object).sort()).toEqual([
                    'enabled',
                    'window_dow',
                    'window_end',
                    'window_start',
                    'window_tz',
                ]);
            }
        }
        // The very columns 20261009150000 grants UPDATE on.
        const grant = /GRANT UPDATE \(([^)]*)\)\s+ON TABLE public\.vessel_quiet_watch TO authenticated/.exec(
            readFileSync('supabase/migrations/20261009150000_vessel_quiet_watch.sql', 'utf8'),
        );
        const granted = grant![1].split(',').map((c) => c.trim());
        expect(granted).not.toContain('owner_id');
        for (const column of Object.keys(settings)) expect(granted).toContain(column);
    });

    it('a refusal (row-level security, a grant, the deletion fence) says refused; anything else failed', async () => {
        db.answers.set('update:vessel_quiet_watch', {
            data: null,
            error: { code: '42501', message: 'permission denied for table vessel_quiet_watch' },
        });
        expect(await saveOwnerQuietWatch(SKIPPER, false, lisbon)).toBe('refused');
        db.answers.set('update:vessel_quiet_watch', { data: null, error: { code: '55000', message: 'fenced' } });
        expect(await saveOwnerQuietWatch(SKIPPER, false, lisbon)).toBe('refused');
        db.answers.set('update:vessel_quiet_watch', { data: [], error: null });
        db.answers.set('insert:vessel_quiet_watch', { data: null, error: { code: '42501', message: 'rls' } });
        expect(await saveOwnerQuietWatch(SKIPPER, false, lisbon)).toBe('refused');
        db.answers.set('update:vessel_quiet_watch', { data: null, error: { code: 'PGRST000', message: 'down' } });
        expect(await saveOwnerQuietWatch(SKIPPER, false, lisbon)).toBe('failed');
    });

    it('a crew member turns their own pages off or on for one boat', async () => {
        db.answers.set('rpc:set_vessel_quiet_watch_crew_page', { data: false, error: null });
        expect(await setCrewQuietPage('o-1', false)).toBe('saved');
        expect(db.calls.at(-1)).toEqual({
            op: 'rpc',
            table: 'set_vessel_quiet_watch_crew_page',
            args: [{ p_owner_id: 'o-1', p_page_me: false }],
        });
        db.answers.set('rpc:set_vessel_quiet_watch_crew_page', missingFunction);
        expect(await setCrewQuietPage('o-1', true)).toBe('failed');
        db.answers.set('rpc:set_vessel_quiet_watch_crew_page', {
            data: null,
            error: { code: '42501', message: 'Only crew she shares her instruments with are paged' },
        });
        expect(await setCrewQuietPage('o-1', false)).toBe('refused');
    });
});
