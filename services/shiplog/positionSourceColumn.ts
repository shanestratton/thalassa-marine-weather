/**
 * Does ship_logs.position_source exist yet? (build 123, package VL)
 *
 * The migration (supabase/migrations/20261007183000_ship_log_position_source.sql)
 * is written but not applied: `supabase db push` waits for Shane's
 * per-action yes. PostgREST refuses a row that names an unknown column, and
 * the offline queue answers a permanent refusal by bisecting to one row and
 * dead-lettering it — a voyage's track moved aside for want of one column.
 * So the queue asks first, and writes the field only after it has SEEN the
 * column. "Absent", "could not ask" and "not asked yet" all mean: leave it
 * off, and the voyage uploads exactly as it did before this build.
 *
 * A present column is remembered for the session; an absent one is asked
 * again after an hour (the push may happen while the app is open); a failed
 * probe is asked again on the next sync.
 */
import { createLogger } from '../../utils/createLogger';
import { SHIP_LOGS_TABLE } from './helpers';
import { isFixSource } from './trackSourcePlan';

const log = createLogger('ShipLog.PositionSource');

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
    return /position_source/.test(error.message ?? '') && /does not exist|could not find/i.test(error.message ?? '');
}

/** Ask (or remember) whether the column exists. Never throws; false unless it was seen. */
export async function positionSourceColumnPresent(client: unknown, now = Date.now()): Promise<boolean> {
    if (known?.present) return true;
    if (known && !known.present && now - known.at < ABSENT_RECHECK_MS) return false;
    if (inFlight) return inFlight;
    inFlight = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const probe = (client as ProbeClient).from(SHIP_LOGS_TABLE).select('position_source').limit(0);
            const result = await Promise.race([
                Promise.resolve(probe),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
                }),
            ]);
            if (!result) return false; // timed out: unknown, ask next time
            if (!result.error) {
                known = { present: true };
                log.warn('ship_logs.position_source is present: track points will carry their receiver');
                return true;
            }
            if (missingColumn(result.error)) {
                known = { present: false, at: now };
                return false;
            }
            return false; // some other refusal: unknown, ask next time
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
 * time-bounded direct save, which must not spend its budget on a probe: until
 * the queue's own sync has asked, it simply leaves the field off.
 */
export function positionSourceColumnKnownPresent(): boolean {
    return known?.present === true;
}

/** Add position_source to one outgoing row, only with the column present and a value the CHECK allows. */
export function withPositionSource(
    row: Record<string, unknown>,
    positionSource: unknown,
    columnPresent: boolean,
): Record<string, unknown> {
    if (columnPresent && isFixSource(positionSource)) row.position_source = positionSource;
    return row;
}

/** Tests only. */
export function __resetPositionSourceColumnForTests(): void {
    known = null;
    inFlight = null;
}
