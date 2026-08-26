/**
 * castOffHandoff — the baton between Cast Off and the Log page.
 *
 * Shane 2026-08-26: "when i press the cast off button and the next button
 * after that, we need it to go to the log page, and act as though we went
 * through that page. at the moment it is all over the place."
 *
 * The old flow held the skipper hostage in CastOffPanel while a cold GPS fix
 * warmed up (or failed) at the dock — sometimes landing on the Log page,
 * sometimes stranding them on Passage Planning with a retry button. Worse,
 * arriving at the Log page before tracking confirmed showed "Slide to Start
 * Tracking", which mints a SECOND voyage.
 *
 * New contract: the moment the voyage is active remotely, Cast Off navigates
 * to the Log page and stashes this handoff. GPS logging starts at service
 * level (it must survive the panel unmounting mid-flight), and the Log page
 * renders the honest state — "GPS starting…", a retry if it fails, and the
 * route-check heads-up if the advisory had something to say. Nothing is
 * presented as live before it is; it is presented as exactly what it is,
 * on the page the skipper expects to be on.
 *
 * Module-level state, deliberately not persisted: a handoff only makes sense
 * in the seconds-to-minutes after a Cast Off in this same app session.
 */

import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';

export type CastOffGpsState = 'starting' | 'failed' | 'confirmed';

export interface CastOffHandoff {
    voyageId: string;
    voyageName: string;
    /** Advisory route-check heads-up from castOff(); null when clean. */
    caution: string | null;
    gps: CastOffGpsState;
    /** Human-readable failure detail when gps === 'failed'. */
    gpsError: string | null;
}

let current: CastOffHandoff | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

export function stashCastOffHandoff(handoff: { voyageId: string; voyageName: string; caution: string | null }): void {
    current = { ...handoff, gps: 'starting', gpsError: null };
    emit();
}

export function peekCastOffHandoff(): CastOffHandoff | null {
    return current;
}

export function updateCastOffHandoff(patch: Partial<Omit<CastOffHandoff, 'voyageId'>>): void {
    if (!current) return;
    current = { ...current, ...patch };
    emit();
}

export function clearCastOffHandoff(): void {
    if (!current) return;
    current = null;
    emit();
}

/** useSyncExternalStore-compatible subscription. */
export function subscribeCastOffHandoff(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Start (or retry) background GPS logging for the handed-off voyage.
 *
 * Shared by CastOffPanel's fire-and-forget start and the Log page's retry
 * button so both paths verify the same way. Never throws — the outcome is
 * reported through the handoff's gps state, which is the UI's single source
 * of truth.
 */
export async function startHandoffGps(retry = false): Promise<void> {
    const handoff = current;
    if (!handoff) return;
    const scope = getAuthIdentityScope();
    updateCastOffHandoff({ gps: 'starting', gpsError: null });
    try {
        const { ShipLogService } = await import('./ShipLogService');
        // freshDeparture=true on the first start only — a retry may already
        // hold a partial fix and must not look like a brand-new cold start.
        await ShipLogService.startTracking(retry, handoff.voyageId, scope, !retry);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const tracking = ShipLogService.getTrackingStatus();
        if (!tracking.isTracking || tracking.currentVoyageId !== handoff.voyageId) {
            throw new Error('Background GPS did not confirm the newly active passage.');
        }
        updateCastOffHandoff({ gps: 'confirmed', gpsError: null });
    } catch (cause) {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const detail =
            cause instanceof Error && cause.message.trim() ? cause.message.trim() : 'Background GPS failed to start.';
        updateCastOffHandoff({ gps: 'failed', gpsError: detail });
    }
}
