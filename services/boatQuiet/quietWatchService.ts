/**
 * The quiet-boat watch's switches (129-08): what Settings → Preferences reads
 * and writes.
 *
 * The skipper's switch is the per-boat opt-in in vessel_quiet_watch (125-11,
 * 20261009150000) with its weekly window in the boat's own zone. It shows
 * only once a COLUMN PROBE of that table answers: the read names every column
 * the switch writes, so a table or column that is not there (or a read that
 * does not answer in time) hides it. With no row yet it is offered only to an
 * account whose Pi reports to the cloud: a watch with no Pi could never page.
 *
 * A crew member's switches (one per boat they crew with Share Instrument
 * Panel) come from vessel_quiet_watch_crew_boats(), which the held migration
 * 20261014180000 adds. Until it answers there are none, and the skipper's line
 * describes 125's watchdog (her alone, no all-clear), not 129-08's.
 *
 * The skipper's switch never upserts. 125's grants let the app UPDATE only
 * the switch and window columns, never owner_id, and PostgreSQL checks UPDATE
 * on every column of an ON CONFLICT ... DO UPDATE SET (PostgREST's upsert
 * names them all, owner_id included) even when nothing conflicts: every
 * upsert would be refused (42501). So: update her row; no row, insert it;
 * another device inserted it first (23505), update again.
 */
import { supabase } from '../supabase';

export interface QuietWindow {
    /** 0 = Sunday … 6 = Saturday, in tz. */
    dow: number;
    /** 'HH:MM', local to tz. */
    start: string;
    end: string;
    /** IANA zone: the boat's own. */
    tz: string;
}

export interface OwnerQuietWatch {
    enabled: boolean;
    graceMin: number;
    window: QuietWindow | null;
}

export interface CrewQuietBoat {
    ownerId: string;
    boatName: string | null;
    watchOn: boolean;
    pagingMe: boolean;
}

export interface QuietWatchView {
    /** Null: no switch for this account's own boat. */
    owner: OwnerQuietWatch | null;
    crew: CrewQuietBoat[];
    /**
     * The 129-08 watchdog answers (its crew call does, even with no boats):
     * crew pages, the all-clear and the window's 10-minute allowance. False:
     * 125's, which pages the skipper alone.
     */
    crewPaging: boolean;
}

/** What a write came to: refused is the server saying no, failed is anything else. */
export type QuietSave = 'saved' | 'refused' | 'failed';

/** The declared weekly window when none is set: the router's old Wednesday reboot. */
export const DEFAULT_QUIET_WINDOW = { dow: 3, start: '19:30', end: '19:50' } as const;
/** A probe that has not answered by then hides the switch. */
export const QUIET_PROBE_TIMEOUT_MS = 8_000;
const WATCH_COLUMNS = 'owner_id,enabled,quiet_after_minutes,window_dow,window_start,window_end,window_tz';
const NONE: QuietWatchView = { owner: null, crew: [], crewPaging: false };

type Answer = { data: unknown; error: unknown };

/** The answer, or null when it failed, threw or did not come in time. */
async function within(request: PromiseLike<Answer> | undefined): Promise<unknown> {
    if (!request) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const answer = await Promise.race([
            Promise.resolve(request),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), QUIET_PROBE_TIMEOUT_MS);
            }),
        ]);
        return answer && !answer.error ? answer.data : null;
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const hhmm = (value: unknown) => (typeof value === 'string' && /^\d\d:\d\d/.test(value) ? value.slice(0, 5) : null);

function ownerFrom(row: Record<string, unknown>): OwnerQuietWatch {
    const start = hhmm(row.window_start);
    const end = hhmm(row.window_end);
    const dow = row.window_dow;
    const tz = row.window_tz;
    return {
        enabled: row.enabled === true,
        graceMin: typeof row.quiet_after_minutes === 'number' ? row.quiet_after_minutes : 15,
        window:
            start && end && typeof dow === 'number' && typeof tz === 'string' && tz ? { dow, start, end, tz } : null,
    };
}

async function loadOwner(userId: string): Promise<OwnerQuietWatch | null> {
    const client = supabase;
    if (!client) return null;
    const rows = await within(client.from('vessel_quiet_watch').select(WATCH_COLUMNS).eq('owner_id', userId).limit(1));
    if (!Array.isArray(rows)) return null;
    if (rows[0] && typeof rows[0] === 'object') return ownerFrom(rows[0] as Record<string, unknown>);
    const pi = await within(client.from('vessel_telemetry').select('source').eq('owner_id', userId).limit(1));
    const reports = Array.isArray(pi) && (pi[0] as { source?: unknown } | undefined)?.source === 'pi';
    return reports ? { enabled: false, graceMin: 15, window: null } : null;
}

/** Null when the call is not there (125 only), failed or did not answer in time. */
async function loadCrew(): Promise<CrewQuietBoat[] | null> {
    const rows = await within(supabase?.rpc('vessel_quiet_watch_crew_boats'));
    if (!Array.isArray(rows)) return null;
    return rows.flatMap((row: Record<string, unknown>) =>
        typeof row?.owner_id === 'string'
            ? [
                  {
                      ownerId: row.owner_id,
                      boatName: typeof row.boat_name === 'string' && row.boat_name.trim() ? row.boat_name : null,
                      watchOn: row.watch_on === true,
                      pagingMe: row.paging_me === true,
                  },
              ]
            : [],
    );
}

/** Both halves at once. Never throws: anything unanswered is no switch. */
export async function loadQuietWatch(userId: string): Promise<QuietWatchView> {
    if (!supabase || !userId) return NONE;
    const [owner, crew] = await Promise.all([loadOwner(userId), loadCrew()]);
    return { owner, crew: crew ?? [], crewPaging: crew !== null };
}

type WriteError = { code?: unknown } | null | undefined;

/** Row-level security or a missing grant (42501), or the account-deletion fence (55000): the server's no. */
const refusedBy = (error: WriteError) => !!error && (error.code === '42501' || error.code === '55000');

const outcome = (error: WriteError): QuietSave => (!error ? 'saved' : refusedBy(error) ? 'refused' : 'failed');

/**
 * The skipper's switch: the opt-in and the weekly window, in the boat's zone.
 * Update, else insert, else (a race with another device) update again; never
 * an upsert (see the header) and never owner_id in an UPDATE.
 */
export async function saveOwnerQuietWatch(userId: string, enabled: boolean, window: QuietWindow): Promise<QuietSave> {
    const client = supabase;
    if (!client || !userId) return 'failed';
    const settings = {
        enabled,
        window_dow: window.dow,
        window_start: window.start,
        window_end: window.end,
        window_tz: window.tz,
    };
    const update = () => client.from('vessel_quiet_watch').update(settings).eq('owner_id', userId).select('owner_id');
    try {
        const updated = await update();
        if (updated.error) return outcome(updated.error);
        if (Array.isArray(updated.data) && updated.data.length > 0) return 'saved';
        const inserted = await client.from('vessel_quiet_watch').insert({ owner_id: userId, ...settings });
        if ((inserted.error as WriteError)?.code !== '23505') return outcome(inserted.error);
        const again = await update();
        if (again.error) return outcome(again.error);
        return Array.isArray(again.data) && again.data.length > 0 ? 'saved' : 'failed';
    } catch {
        return 'failed';
    }
}

/** A crew member's own pages for one boat. */
export async function setCrewQuietPage(ownerId: string, pageMe: boolean): Promise<QuietSave> {
    if (!supabase) return 'failed';
    try {
        const { error } = await supabase.rpc('set_vessel_quiet_watch_crew_page', {
            p_owner_id: ownerId,
            p_page_me: pageMe,
        });
        return outcome(error);
    } catch {
        return 'failed';
    }
}
