import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { supabase } from '../supabase';
import { getFullQueue, getLocalDatabaseSession } from '../vessel/LocalDatabase';
import { getBinderSource } from '../vessel/sharedBinders';
import { useSettingsStore } from '../../stores/settingsStore';
import { engineRunSummary, validEngineRunCounter } from './engineRunCounter';
import type { EngineHoursOffer } from './engineHoursOffer';
export type { EngineHoursOffer } from './engineHoursOffer';
export interface EngineHoursReview {
    hours: number | null;
    alreadyConfirmed: boolean;
}
export interface EngineHoursConfirmation {
    applied: boolean;
    hours: number;
    remainderSeconds: number;
}

function assertOwner(scope: AuthIdentityScope, boatId?: string): void {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed. Reopen this voyage.');
    if (getBinderSource('maintenance').mode !== 'own')
        throw new Error('Open your own boat’s Maintenance to review its engine hours.');
    if (getLocalDatabaseSession().identity !== scope.userId) throw new Error('Wait for your Maintenance data to load.');
    if (getFullQueue().some((row) => row.table_name === 'vessel_engine_hours'))
        throw new Error('Sync the pending engine-hour edit in Maintenance first.');
    const active = useSettingsStore.getState().activeVesselId;
    if (boatId && active && boatId !== active)
        throw new Error('Switch back to the voyage’s boat before changing its engine hours.');
}

export async function loadEngineHoursReview(offer: EngineHoursOffer, signal: AbortSignal): Promise<EngineHoursReview> {
    assertOwner(offer.scope, offer.boatId);
    if (!supabase) throw new Error('Connect to review the current engine-hour reading.');
    const owner = offer.scope.userId!;
    const [reading, receipt] = await Promise.all([
        supabase
            .from('vessel_engine_hours')
            .select('user_id,hours')
            .eq('user_id', owner)
            .abortSignal(signal)
            .maybeSingle(),
        supabase
            .from('voyage_engine_hours_receipts')
            .select('voyage_id')
            .eq('user_id', owner)
            .eq('voyage_id', offer.counter.voyageId)
            .abortSignal(signal)
            .maybeSingle(),
    ]);
    assertOwner(offer.scope, offer.boatId);
    if (signal.aborted) throw new Error('Review cancelled.');
    if (reading.error || receipt.error)
        throw new Error('Engine hours can’t be added here yet. Check the meter in Maintenance.');
    const row = reading.data;
    if (row && (row.user_id !== owner || !Number.isInteger(row.hours) || row.hours < 0 || row.hours > 999999))
        throw new Error('The engine-hour reading needs review in Maintenance.');
    return { hours: row?.hours ?? null, alreadyConfirmed: !!receipt.data };
}

export async function confirmEngineHours(
    offer: EngineHoursOffer,
    expectedHours: number,
    signal: AbortSignal,
): Promise<EngineHoursConfirmation> {
    assertOwner(offer.scope, offer.boatId);
    const { counter } = offer;
    if (!validEngineRunCounter(counter, counter.voyageId) || !counter.ended || counter.clockUncertain)
        throw new Error('Review the engine hour meter in Maintenance after this clock change.');
    const summary = engineRunSummary(counter);
    if (
        !Number.isInteger(expectedHours) ||
        expectedHours < 0 ||
        expectedHours > 999999 ||
        summary.seconds < 1 ||
        !supabase
    )
        throw new Error('Review the current engine-hour reading first.');
    if (signal.aborted) throw new Error('Confirmation cancelled.');
    const source = summary.measuredSeconds === 0 ? 'log' : summary.loggedSeconds === 0 ? 'rpm' : 'mixed';
    const { data, error } = await supabase
        .rpc('confirm_voyage_engine_hours', {
            p_voyage_id: counter.voyageId,
            p_seconds: summary.seconds,
            p_source: source,
            p_expected_hours: expectedHours,
        })
        .abortSignal(signal);
    if (!isAuthIdentityScopeCurrent(offer.scope)) throw new Error('Account changed. Reopen this voyage.');
    if (error) {
        if (error.code === '40001') throw new Error('The engine-hour reading changed. Reload it before confirming.');
        throw new Error('Confirmation wasn’t received. Reopen to check; retrying this voyage cannot add it twice.');
    }
    if (
        !data ||
        typeof data.applied !== 'boolean' ||
        !Number.isInteger(data.hours) ||
        data.hours < 0 ||
        data.hours > 999999 ||
        !Number.isInteger(data.remainderSeconds) ||
        data.remainderSeconds < 0 ||
        data.remainderSeconds > 3599
    )
        throw new Error('Check the confirmed reading in Maintenance.');
    // Refresh the mirror; never queue a second absolute meter write after the atomic RPC.
    void import('../vessel/SyncService')
        .then(({ forceFullPull }) => {
            if (isAuthIdentityScopeCurrent(offer.scope)) return forceFullPull();
        })
        .catch(() => undefined);
    return data as EngineHoursConfirmation;
}
