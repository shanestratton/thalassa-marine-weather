/**
 * Recover lost route checks from the server, at zero grading cost (build
 * 124, B3).
 *
 * A check lives on the device (thalassa_traced_routes_v1); saved_routes has no
 * verification column, and sync deliberately carries none to another device.
 * So a reinstall, a second phone or the silent 50-route cap re-adopting a
 * passage from the account brought its legs back UNCHECKED — Shane's three
 * yellow Newport → Whitsundays legs (2026-10-08). But every tracer Save of a
 * passage leg also writes that leg's check into its Passage Planning mirror
 * (voyages.notes, PassagePlanSave). This reads it back: one query, then the
 * same safe bank everything else uses, which re-proves the note against the
 * device's CURRENT pins and never replaces a newer check.
 *
 * A recovered September check still shows amber "Last checked 12 Sep" (the
 * 30-day rule) — honest and followable; the background re-check refreshes it.
 */
import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { bankTraceVerification, loadSavedTraces } from './routeTracer';
import { parseTraceVerificationNote, traceFollowStatus } from './traceVerification';
import { useSettingsStore } from '../stores/settingsStore';
import { vesselDraftIsAssumed, vesselDraftMetres } from './units';
import { createLogger } from '../utils/createLogger';

const log = createLogger('traceCheckRecovery');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns how many checks were banked. Never throws; a failed query writes nothing. */
export async function recoverTraceChecks(
    scope: AuthIdentityScope = getAuthIdentityScope(),
    traceIds?: readonly string[],
): Promise<number> {
    try {
        if (!scope.userId || !supabase || !isAuthIdentityScopeCurrent(scope)) return 0;
        const vessel = useSettingsStore.getState().settings?.vessel;
        const context = {
            draftM: vesselDraftMetres(vessel),
            draftAssumed: vesselDraftIsAssumed(vessel),
            nowMs: Date.now(),
        };
        const wanted = traceIds ? new Set(traceIds) : null;
        const byVoyage = new Map<string, string>();
        for (const trace of loadSavedTraces(scope)) {
            const voyageId = trace.passageVoyageId?.trim();
            if (!voyageId || !UUID_RE.test(voyageId) || (wanted && !wanted.has(trace.id))) continue;
            if (traceFollowStatus(trace.verification, trace.points, context).tone === 'checked') continue;
            byVoyage.set(voyageId, trace.id);
        }
        if (byVoyage.size === 0) return 0;

        const { data, error } = await supabase
            .from('voyages')
            .select('id, notes, saved_route_id')
            .in('id', [...byVoyage.keys()])
            .eq('user_id', scope.userId);
        if (!isAuthIdentityScopeCurrent(scope)) {
            log.warn('recovery dropped: the account changed while the query was out');
            return 0;
        }
        if (error || !Array.isArray(data)) {
            log.warn(`recovery skipped: voyages query failed (${error?.message ?? 'no rows'})`);
            return 0;
        }

        let banked = 0;
        for (const row of data as Array<{ id: string; notes: string | null; saved_route_id: string | null }>) {
            const traceId = byVoyage.get(row.id);
            if (!traceId || row.saved_route_id !== traceId) {
                log.warn(`recovery ignored a mirror linked to another route (${row.id})`);
                continue;
            }
            const current = loadSavedTraces(scope).find((trace) => trace.id === traceId);
            const proof = current ? parseTraceVerificationNote(row.notes, current.points) : null;
            if (!proof) {
                log.warn(`recovery found no proof for these pins on ${row.id}`);
                continue;
            }
            const result = bankTraceVerification(traceId, proof, scope, { refreshMirror: false });
            if (result.banked) banked += 1;
            else log.warn(`recovered proof not banked for ${traceId} (${result.reason})`);
        }
        log.warn(`recovered ${banked} route check${banked === 1 ? '' : 's'} from the server`);
        return banked;
    } catch (error) {
        log.warn('recovery failed:', error);
        return 0;
    }
}
