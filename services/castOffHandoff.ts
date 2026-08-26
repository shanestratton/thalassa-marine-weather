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
 * Persisted to localStorage with a 12-hour shelf life: the app dying right
 * after Cast Off (Shane's boat, 2026-08-26 — flight recorder logged a kill
 * seconds after departure) used to take the handoff with it, so the Log page
 * never showed the GPS-failed retry card and the passage sat "active, GPS
 * log off" for an hour. A restored handoff that was still 'starting' when
 * the process died is downgraded to 'failed' — the start never confirmed —
 * and the Log page auto-retries it once.
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
    /** Automatic retry attempts made so far (max 2 before going manual). */
    retryCount: number;
    /** Show the passage's route on the public page once GPS confirms —
     *  the skipper's choice from the Cast Off confirm step. */
    publishRoute: boolean;
    /** Saved trace backing this passage — resolves the planned-route mirror
     *  id the public page draws from. */
    savedRouteId: string | null;
}

const PERSIST_KEY = 'thalassa_castoff_handoff';
const PERSIST_MAX_AGE_MS = 12 * 3_600_000;

interface PersistedHandoff extends CastOffHandoff {
    stashedAt: number;
}

function restore(): CastOffHandoff | null {
    try {
        const raw = localStorage.getItem(PERSIST_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedHandoff;
        if (!parsed?.voyageId || typeof parsed.stashedAt !== 'number') return null;
        if (Date.now() - parsed.stashedAt > PERSIST_MAX_AGE_MS) return null;
        const { stashedAt: _stashedAt, ...handoff } = parsed;
        // 'starting' cannot survive a process death — the start never
        // confirmed. Report it honestly so the retry surface appears.
        // Older persisted blobs predate the publish choice — default on.
        const withPublish = {
            ...handoff,
            publishRoute: handoff.publishRoute ?? true,
            savedRouteId: handoff.savedRouteId ?? null,
        };
        if (withPublish.gps === 'starting') {
            return { ...withPublish, gps: 'failed', gpsError: 'The app closed before GPS logging confirmed.' };
        }
        return withPublish;
    } catch {
        return null;
    }
}

function persist(): void {
    try {
        if (!current) {
            localStorage.removeItem(PERSIST_KEY);
        } else {
            localStorage.setItem(PERSIST_KEY, JSON.stringify({ ...current, stashedAt: Date.now() }));
        }
    } catch {
        /* persistence is a convenience; the in-memory handoff still works */
    }
}

let current: CastOffHandoff | null = restore();
const listeners = new Set<() => void>();

function emit(): void {
    persist();
    for (const listener of listeners) listener();
}

export function stashCastOffHandoff(handoff: {
    voyageId: string;
    voyageName: string;
    caution: string | null;
    publishRoute?: boolean;
    savedRouteId?: string | null;
}): void {
    current = {
        ...handoff,
        publishRoute: handoff.publishRoute ?? true,
        savedRouteId: handoff.savedRouteId ?? null,
        gps: 'starting',
        gpsError: null,
        retryCount: 0,
    };
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
        // Tracking is live NOW — this is the moment the public page can
        // actually link the passage. Publishing any earlier returns
        // 'not-tracking' and records nothing durable, which is why a
        // cast-off passage never appeared publicly (Shane 2026-08-26:
        // "it is not showing on the public page"). Opt-out honoured;
        // publishFollowedRoute queues durably on network failure.
        if (handoff.publishRoute !== false) {
            try {
                // The public page draws the plan from ship_logs rows with
                // source='planned_route' under the PLANNED-ROUTE MIRROR
                // voyage — the saved trace's plannedRouteId — never the
                // cast-off voyage itself, whose entries are live GPS fixes
                // (linking the cast-off voyage to itself resolved to zero
                // plan points and the passage never appeared; Shane
                // 2026-08-26: "i pressed the show on the public page button,
                // but it is not showing").
                const planShiplogVoyageId = await resolvePlannedMirrorId(handoff.savedRouteId);
                if (planShiplogVoyageId) {
                    const { publishFollowedRoute } = await import('./shiplog/publishFollowedRoute');
                    await publishFollowedRoute(planShiplogVoyageId);
                }
            } catch {
                /* the durable-intent layer owns retries */
            }
        }
    } catch (cause) {
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const detail =
            cause instanceof Error && cause.message.trim() ? cause.message.trim() : 'Background GPS failed to start.';
        updateCastOffHandoff({ gps: 'failed', gpsError: detail });
        scheduleAutoRetry();
    }
}

/**
 * The retry ladder — 8 s, then 30 s, then manual only.
 *
 * The cast-off GPS start races the PREVIOUS voyage's teardown when the
 * skipper ends one passage and immediately casts off the next (End Voyage →
 * pick route → Cast Off inside a minute): the fresh start throws
 * "finish the pending teardown"/DifferentVoyage and nothing recovered
 * unless the Log page happened to be visited. Manual retry always worked
 * because human seconds are longer than teardowns — so retry like a human,
 * automatically, from module level where no particular page needs to be
 * open (Shane's 9:15pm "GPS LOG OFF" panel, an hour after departure).
 */
let autoRetryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoRetry(): void {
    const handoff = current;
    if (!handoff || handoff.gps !== 'failed') return;
    if (handoff.retryCount >= 2) return;
    if (autoRetryTimer) clearTimeout(autoRetryTimer);
    const delayMs = handoff.retryCount === 0 ? 8_000 : 30_000;
    autoRetryTimer = setTimeout(() => {
        autoRetryTimer = null;
        const latest = current;
        if (!latest || latest.gps !== 'failed') return;
        updateCastOffHandoff({ retryCount: latest.retryCount + 1 });
        void startHandoffGps(true);
    }, delayMs);
}

// A handoff restored as 'failed' (the app died mid-start) begins its retry
// ladder immediately — recovery must not wait for a page visit.
if (current?.gps === 'failed') scheduleAutoRetry();

/** The saved trace's planned-route mirror voyage id — what voyage_plan_links
 *  must point at for the public page to draw the plan line. Null when the
 *  trace is missing or predates mirror ids (nothing public could draw). */
async function resolvePlannedMirrorId(savedRouteId: string | null): Promise<string | null> {
    const routeId = savedRouteId?.trim();
    if (!routeId) return null;
    try {
        const { loadSavedTraces } = await import('./routeTracer');
        const trace = loadSavedTraces().find((candidate) => candidate.id === routeId);
        const mirror = trace?.plannedRouteId?.trim();
        return mirror || null;
    } catch {
        return null;
    }
}
