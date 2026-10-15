/**
 * Does the server keep a task's service records when the task is deleted?
 * (131-B7, binder audit MAINT-02)
 *
 * The change comes with a HELD migration
 * (supabase/held-migrations/20261015120000_maintenance_history_keeps_records.sql)
 * that Shane pushes himself: in one go it adds maintenance_history.task_title
 * and turns the records' foreign key from ON DELETE CASCADE to SET NULL. Until
 * it is live a deleted task takes its records with it on every device, and R&M
 * says so before the delete (126-B7a). A COLUMN PROBE of task_title is what
 * says it is live: a read that names the column and asks for no rows.
 * "Absent", "could not ask" and "not asked yet" all mean: the records go, so
 * say so. A present column is remembered for the session; an absent one is
 * asked again after an hour (the push may happen while the app is open); a
 * probe that failed or did not answer in time is asked again next time.
 */
import { createLogger } from '../../utils/createLogger';

const log = createLogger('Maintenance.HistoryColumn');

const PROBE_TIMEOUT_MS = 5_000;
const ABSENT_RECHECK_MS = 60 * 60_000;

type Known = { present: true } | { present: false; at: number };
let known: Known | null = null;
let inFlight: Promise<boolean> | null = null;

/** The minimal client surface the probe needs (a Supabase client satisfies it). */
interface ProbeClient {
    from: (table: string) => {
        select: (columns: string) => {
            limit: (count: number) => PromiseLike<{ error: { code?: string; message?: string } | null }>;
        };
    };
}

function missingColumn(error: { code?: string; message?: string }): boolean {
    // 42703: undefined column (Postgres). PGRST204: column not in PostgREST's schema cache.
    if (error.code === '42703' || error.code === 'PGRST204') return true;
    return /task_title/.test(error.message ?? '') && /does not exist|could not find/i.test(error.message ?? '');
}

/**
 * Ask (or remember) whether a deleted task's records stay. Never throws;
 * false unless the column was seen. `client` is the Supabase client.
 */
export async function maintenanceHistoryKeepsRecords(client: unknown, now = Date.now()): Promise<boolean> {
    if (known?.present) return true;
    if (known && !known.present && now - known.at < ABSENT_RECHECK_MS) return false;
    if (inFlight) return inFlight;
    inFlight = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const probe = (client as ProbeClient).from('maintenance_history').select('task_title').limit(0);
            const result = await Promise.race([
                Promise.resolve(probe),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
                }),
            ]);
            if (!result) return false; // timed out: unknown, ask next time
            if (!result.error) {
                known = { present: true };
                log.warn('maintenance_history.task_title is present: a deleted task keeps its records');
                return true;
            }
            if (missingColumn(result.error)) {
                known = { present: false, at: now };
                return false;
            }
            return false; // some other refusal (signed out, say): unknown, ask next time
        } catch {
            return false; // offline or no client: unknown, ask next time
        } finally {
            if (timer) clearTimeout(timer);
            inFlight = null;
        }
    })();
    return inFlight;
}

/**
 * Has the column already been SEEN this session? A synchronous peek for the
 * delete itself (LocalMaintenanceService.deleteTask), which must not wait on
 * the network: until R&M's own probe has answered, the records go.
 */
export function maintenanceHistoryKeptKnown(): boolean {
    return known?.present === true;
}

/** Tests only. */
export function __resetMaintenanceHistoryColumnForTests(): void {
    known = null;
    inFlight = null;
}
