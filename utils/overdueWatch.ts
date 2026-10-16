import { shoreRecord, shoreUuid } from './shoreContacts.ts';
export const OVERDUE_GRACE_MS = 10 * 60_000;
export const OVERDUE_WINDOW_MS = 24 * 60 * 60_000;
export interface OverduePlan {
    vesselLabel: string;
    from: string;
    to: string;
    departureAt: number;
    etaAt: number | null;
    overdueAt: number;
    persons: number;
}
export interface OverdueConfiguration {
    enabled: boolean;
    plan: OverduePlan;
    contacts: { id: string; revision: string }[];
    sharePosition: boolean;
    /** Owner reviewed region; never infer rescue jurisdiction from an approximate map rectangle. */
    rescueRegion: 'au' | 'nz' | 'us' | 'uk' | 'fr' | null;
}
export interface OverdueState {
    ownerQueuedAt: number | null;
    ownerAttemptedAt: number | null;
    contactsQueuedAt: number | null;
    endedAt: number | null;
}
const keys = (v: Record<string, unknown>, allowed: string[]) =>
    Object.keys(v).length === allowed.length && allowed.every((k) => Object.hasOwn(v, k));
const text = (v: unknown): v is string =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 80 &&
    v.trim() === v &&
    ![...v].some(
        (c) => (c.codePointAt(0) ?? 0) < 32 || ((c.codePointAt(0) ?? 0) >= 127 && (c.codePointAt(0) ?? 0) <= 159),
    );
const time = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 8_640_000_000_000_000;
export function parseOverduePlan(v: unknown): OverduePlan | null {
    if (
        !shoreRecord(v) ||
        !keys(v, ['vesselLabel', 'from', 'to', 'departureAt', 'etaAt', 'overdueAt', 'persons']) ||
        ![v.vesselLabel, v.from, v.to].every(text) ||
        !time(v.departureAt) ||
        !time(v.overdueAt) ||
        v.overdueAt <= v.departureAt ||
        v.overdueAt - v.departureAt > 180 * 24 * 3600_000 ||
        (v.etaAt !== null && (!time(v.etaAt) || v.etaAt < v.departureAt || v.etaAt > v.overdueAt)) ||
        typeof v.persons !== 'number' ||
        !Number.isSafeInteger(v.persons) ||
        v.persons < 1 ||
        v.persons > 100
    )
        return null;
    return v as unknown as OverduePlan;
}
export function parseOverdueConfiguration(v: unknown, now = Date.now(), arming = false): OverdueConfiguration | null {
    if (
        !shoreRecord(v) ||
        !keys(v, ['enabled', 'plan', 'contacts', 'sharePosition', 'rescueRegion']) ||
        (v.rescueRegion !== null && !['au', 'nz', 'us', 'uk', 'fr'].includes(String(v.rescueRegion))) ||
        typeof v.enabled !== 'boolean' ||
        typeof v.sharePosition !== 'boolean' ||
        !parseOverduePlan(v.plan) ||
        !Array.isArray(v.contacts) ||
        v.contacts.length < 1 ||
        v.contacts.length > 10
    )
        return null;
    const ids = new Set();
    for (const r of v.contacts) {
        if (
            !shoreRecord(r) ||
            !keys(r, ['id', 'revision']) ||
            !shoreUuid(r.id) ||
            !shoreUuid(r.revision) ||
            ids.has(r.id)
        )
            return null;
        ids.add(r.id);
    }
    const plan = v.plan as unknown as OverduePlan;
    if (
        arming &&
        (plan.overdueAt < now + 300_000 ||
            plan.overdueAt > now + 180 * 24 * 3600_000 ||
            plan.departureAt < now - 180 * 24 * 3600_000)
    )
        return null;
    return v as unknown as OverdueConfiguration;
}
export interface OverdueNotice {
    overdue_watch: 1;
    boatId: string;
    revision: string;
    overdueAt: number;
    expiresAt: number;
}
export function parseOverdueNotice(v: unknown, now = Date.now()): OverdueNotice | null {
    if (
        !shoreRecord(v) ||
        !keys(v, ['overdue_watch', 'boatId', 'revision', 'overdueAt', 'expiresAt']) ||
        v.overdue_watch !== 1 ||
        !shoreUuid(v.boatId) ||
        !shoreUuid(v.revision) ||
        !time(v.overdueAt) ||
        !time(v.expiresAt) ||
        !time(now) ||
        v.overdueAt > now ||
        v.expiresAt <= now ||
        v.expiresAt > now + 600_000 ||
        v.expiresAt > v.overdueAt + OVERDUE_WINDOW_MS
    )
        return null;
    return v as unknown as OverdueNotice;
}
export function parseOverdueState(v: unknown): OverdueState | null {
    if (
        !shoreRecord(v) ||
        !keys(v, ['ownerQueuedAt', 'ownerAttemptedAt', 'contactsQueuedAt', 'endedAt']) ||
        Object.values(v).some((x) => x !== null && !time(x))
    )
        return null;
    const s = v as unknown as OverdueState;
    if (
        (s.ownerAttemptedAt !== null && (s.ownerQueuedAt === null || s.ownerAttemptedAt < s.ownerQueuedAt)) ||
        (s.contactsQueuedAt !== null &&
            (s.ownerAttemptedAt === null || s.contactsQueuedAt < s.ownerAttemptedAt + OVERDUE_GRACE_MS)) ||
        (s.endedAt !== null &&
            [s.ownerQueuedAt, s.ownerAttemptedAt, s.contactsQueuedAt].some((at) => at !== null && at > s.endedAt!))
    )
        return null;
    return s;
}
export function evaluateOverdue(
    c: OverdueConfiguration,
    s: OverdueState,
    now: number,
): { action: 'owner' | 'contacts' | null; reason: string } {
    if (
        !parseOverdueConfiguration(c) ||
        !parseOverdueState(s) ||
        !time(now) ||
        Object.values(s).some((v) => v !== null && v > now)
    )
        return { action: null, reason: 'unknown' };
    if ([s.ownerQueuedAt, s.ownerAttemptedAt, s.contactsQueuedAt].some((at) => at !== null && at < c.plan.overdueAt))
        return { action: null, reason: 'unknown' };
    if (s.endedAt !== null) return { action: null, reason: 'ended' };
    if (!c.enabled) return { action: null, reason: 'off' };
    if (now < c.plan.overdueAt) return { action: null, reason: 'not-due' };
    if (now > c.plan.overdueAt + OVERDUE_WINDOW_MS) return { action: null, reason: 'expired-review-required' };
    if (s.ownerQueuedAt === null) return { action: 'owner', reason: 'owner-first' };
    if (s.ownerAttemptedAt === null) return { action: null, reason: 'awaiting-owner-attempt' };
    if (now < s.ownerAttemptedAt + OVERDUE_GRACE_MS) return { action: null, reason: 'owner-grace' };
    return s.contactsQueuedAt === null
        ? { action: 'contacts', reason: 'unconfirmed-overdue' }
        : { action: null, reason: 'notices-queued' };
}
export function overduePlanWords(value: unknown): string | null {
    const plan = parseOverduePlan(value);
    if (!plan) return null;
    return `${plan.vesselLabel}: ${plan.from} to ${plan.to}. Departure ${new Date(plan.departureAt).toISOString()}; ETA ${plan.etaAt === null ? 'not supplied' : new Date(plan.etaAt).toISOString()}; overdue ${new Date(plan.overdueAt).toISOString()}. ${plan.persons} person(s) aboard. No confirmed arrival is recorded in this watch. This is not proof of distress.`;
}
export function overduePositionWords(value: unknown, now: number): string {
    if (
        !shoreRecord(value) ||
        typeof value.lat !== 'number' ||
        !Number.isFinite(value.lat) ||
        Math.abs(value.lat) > 90 ||
        typeof value.lon !== 'number' ||
        !Number.isFinite(value.lon) ||
        Math.abs(value.lon) > 180 ||
        !time(value.at) ||
        value.at > now ||
        now - value.at > OVERDUE_WINDOW_MS
    )
        return 'Position unavailable. Do not infer the boat’s present location.';
    return `Last explicitly shared report: ${value.lat.toFixed(5)}, ${value.lon.toFixed(5)}, measured ${new Date(value.at).toISOString()} (${Math.floor((now - value.at) / 60_000)} minutes old). The boat may have moved; this is not live tracking.`;
}
