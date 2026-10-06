/**
 * lastPassageStatus — the Crew & Float Plan page's memory of the passage
 * access it last VERIFIED, per account (Shane 2026-10-06: the page sat on
 * "Checking passage access…" on every visit while getPassageStatus made its
 * round trips).
 *
 * The page paints this at once and verifies in the background, as the crew
 * chat card does with its own gate. It is a first paint, never the authority:
 *
 * - It is kept under authScopedStorageKey and stamped with the account, so
 *   another account on the device never reads it, and account deletion sweeps
 *   it with the rest of the account's keys.
 * - Only a granted status is kept, for the one passage it was granted for. A
 *   verification that answers "no access" (revoked) forgets it, so a denied
 *   passage never paints as granted again. The page leaves it alone when the
 *   device is offline, because getPassageStatus fails closed with the same
 *   "no access" when it cannot reach the server.
 * - The live answer always replaces the paint when it lands, and the paint
 *   lasts no more than 6 s without one (CrewManagement). Every action on the
 *   page that changes anything (departure, the Summary card's roll-forward,
 *   Cast Off, delegation, Galley purchases, the watch plan, a passage invite)
 *   still waits for that verified answer. The server's RLS checks every read
 *   and write as before.
 */
import { authScopedStorageKey, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import type { PassageStatus } from '../PassagePlanService';

const STATUS_KEY = 'thalassa_crew_page_passage_status_v1';

interface Memory {
    version: 1;
    userId: string;
    voyageId: string;
    status: PassageStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only the status's own fields, each strictly typed: true means true. */
function parseStatus(value: unknown, voyageId: string): PassageStatus | null {
    if (!isRecord(value) || value.visible !== true || value.voyageId !== voyageId) return null;
    if (typeof value.ownerUserId !== 'string' || !value.ownerUserId) return null;
    return {
        visible: true,
        voyageId,
        ownerUserId: value.ownerUserId,
        isOwner: value.isOwner === true,
        canEditStores: value.canEditStores === true,
        canViewMeals: value.canViewMeals === true,
        canViewChat: value.canViewChat === true,
        canViewRoute: value.canViewRoute === true,
        canViewChecklist: value.canViewChecklist === true,
    };
}

/** The status last verified for this passage on this account, or null. Never throws. */
export function readLastPassageStatus(
    scope: AuthIdentityScope,
    voyageId: string | null | undefined,
): PassageStatus | null {
    if (!scope.userId || !voyageId) return null;
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(authScopedStorageKey(STATUS_KEY, scope));
        if (!raw) return null;
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value) || value.version !== 1 || value.userId !== scope.userId) return null;
        if (value.voyageId !== voyageId) return null;
        const status = parseStatus(value.status, voyageId);
        // An owner grant must name this account as the owner.
        if (status?.isOwner && status.ownerUserId !== scope.userId) return null;
        return status;
    } catch {
        return null;
    }
}

/**
 * Remember what a verification answered for this passage: a grant is kept, a
 * denial forgets any grant held for it. Skips a scope that is no longer
 * current; never throws.
 */
export function rememberPassageStatus(scope: AuthIdentityScope, voyageId: string, status: PassageStatus): void {
    if (!scope.userId || !voyageId || !isAuthIdentityScopeCurrent(scope)) return;
    try {
        if (typeof localStorage === 'undefined') return;
        const key = authScopedStorageKey(STATUS_KEY, scope);
        const granted = parseStatus(status, voyageId);
        if (!granted || (granted.isOwner && granted.ownerUserId !== scope.userId)) {
            const raw = localStorage.getItem(key);
            if (!raw) return;
            let held: unknown = null;
            try {
                held = JSON.parse(raw);
            } catch {
                held = null;
            }
            // A grant for another passage stays; an unreadable record goes.
            if (!isRecord(held) || held.voyageId === voyageId) localStorage.removeItem(key);
            return;
        }
        const memory: Memory = { version: 1, userId: scope.userId, voyageId, status: granted };
        const next = JSON.stringify(memory);
        if (localStorage.getItem(key) !== next) localStorage.setItem(key, next);
    } catch {
        /* storage unavailable: the page still follows the live answer this visit */
    }
}
