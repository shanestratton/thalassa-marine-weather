/**
 * The checklist run in progress, kept on this phone as it is ticked
 * (132-B16, CHK-04).
 *
 * A run used to live only in the page's memory: an app the phone closed in
 * the background, a crash, or a stray Back lost every tick. Now each tick is
 * written here, and the Checklists page puts the run back on screen when it
 * next opens. Only Complete saves the run to checklist_runs (and so to the
 * skipper's other devices); a half-done run stays on the phone that ran it.
 *
 * The Diary's pattern for a draft that must outlive the process
 * (DiaryService._savePending): localStorage, under a key scoped to the
 * signed-in account (so account deletion's suffix sweep removes it), stamped
 * with its owner, and read back after every write to prove it landed.
 */
import { authScopedStorageKey, getAuthIdentityScope, type AuthIdentityScope } from '../authIdentityScope';
import type { ChecklistRunItem, RunItemStatus } from './LocalChecklistService';

const DRAFT_KEY = 'thalassa_checklist_run_draft_v1';

export interface ChecklistRunDraft {
    /** The account that started the run; a draft read under any other is ignored. */
    owner_user_id: string | null;
    /** The run's id: Complete saves the run under it. */
    id: string;
    /** The checklist being run, and its name when the run started. */
    heading_id: string;
    heading: string;
    started_at: string;
    items: ChecklistRunItem[];
}

const STATUSES: readonly RunItemStatus[] = ['unchecked', 'pass', 'fail'];

function isRunItem(value: unknown): value is ChecklistRunItem {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return (
        typeof item.entry_id === 'string' &&
        typeof item.heading === 'string' &&
        typeof item.text === 'string' &&
        STATUSES.includes(item.status as RunItemStatus) &&
        typeof item.flagged_rm === 'boolean'
    );
}

function parseDraft(raw: string | null, scope: AuthIdentityScope): ChecklistRunDraft | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const draft = parsed as Record<string, unknown>;
        if (draft.owner_user_id !== scope.userId) return null;
        if (
            typeof draft.id !== 'string' ||
            typeof draft.heading_id !== 'string' ||
            typeof draft.heading !== 'string' ||
            typeof draft.started_at !== 'string' ||
            !Array.isArray(draft.items) ||
            draft.items.length === 0 ||
            !draft.items.every(isRunItem)
        ) {
            return null;
        }
        return draft as unknown as ChecklistRunDraft;
    } catch {
        return null;
    }
}

/** The run left in progress on this phone by this account, or null. */
export function readRunDraft(scope: AuthIdentityScope = getAuthIdentityScope()): ChecklistRunDraft | null {
    try {
        return parseDraft(localStorage.getItem(authScopedStorageKey(DRAFT_KEY, scope)), scope);
    } catch {
        return null;
    }
}

/**
 * Keep the run as it stands. True only once it reads back as written: a full
 * or refused store says false, and the page tells the skipper the run will
 * not survive the app closing.
 */
export function saveRunDraft(
    draft: Omit<ChecklistRunDraft, 'owner_user_id'>,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): boolean {
    const owned: ChecklistRunDraft = { ...draft, owner_user_id: scope.userId };
    const key = authScopedStorageKey(DRAFT_KEY, scope);
    try {
        const serialized = JSON.stringify(owned);
        localStorage.setItem(key, serialized);
        return localStorage.getItem(key) === serialized;
    } catch {
        return false;
    }
}

/** The run was completed or discarded: nothing to bring back. */
export function clearRunDraft(scope: AuthIdentityScope = getAuthIdentityScope()): void {
    try {
        localStorage.removeItem(authScopedStorageKey(DRAFT_KEY, scope));
    } catch {
        /* storage unavailable: a stale draft is offered once more and can be discarded */
    }
}
