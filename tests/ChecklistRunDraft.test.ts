/**
 * The checklist run in progress, kept on the phone as it is ticked (132-B16,
 * CHK-04): services/vessel/checklistRunDraft. The Diary's pattern for a draft
 * that outlives the process: localStorage under the account's own key, the
 * owner stamped on it, read back after every write. Fictional list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, type AuthIdentityScope } from '../services/authIdentityScope';
import { clearRunDraft, readRunDraft, saveRunDraft } from '../services/vessel/checklistRunDraft';

const skipper: AuthIdentityScope = { key: 'user:skipper-a', userId: 'skipper-a', generation: 1 };
const crew: AuthIdentityScope = { key: 'user:crew-b', userId: 'crew-b', generation: 2 };
const KEY = 'thalassa_checklist_run_draft_v1';

const draft = {
    id: 'run-1',
    heading_id: 'h-pre',
    heading: 'Pre-departure',
    started_at: '2026-10-13T04:05:00.000Z',
    items: [
        {
            entry_id: 'i-bilge',
            heading: 'Pre-departure',
            heading_id: 'h-pre',
            text: 'Bilge pump',
            status: 'fail' as const,
            flagged_rm: true,
            notes: '',
        },
        {
            entry_id: 'i-seacocks',
            heading: 'Pre-departure',
            heading_id: 'h-pre',
            text: 'Close seacocks',
            status: 'unchecked' as const,
            flagged_rm: false,
            notes: '',
        },
    ],
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('checklist run draft', () => {
    it('keeps the run under the account that ran it, and reads it back whole', () => {
        expect(saveRunDraft(draft, skipper)).toBe(true);
        expect(readRunDraft(skipper)).toEqual({ ...draft, owner_user_id: 'skipper-a' });
        // The account-scoped key: account deletion's suffix sweep removes it.
        expect(localStorage.getItem(authScopedStorageKey(KEY, skipper))).not.toBeNull();
    });

    it('another account on the same phone never sees it', () => {
        saveRunDraft(draft, skipper);
        expect(readRunDraft(crew)).toBeNull();
        // Not even copied under the other account's key by hand.
        localStorage.setItem(
            authScopedStorageKey(KEY, crew),
            localStorage.getItem(authScopedStorageKey(KEY, skipper))!,
        );
        expect(readRunDraft(crew)).toBeNull();
    });

    it('clear leaves nothing to bring back', () => {
        saveRunDraft(draft, skipper);
        clearRunDraft(skipper);
        expect(readRunDraft(skipper)).toBeNull();
    });

    it('an unreadable or half-written draft is no draft', () => {
        const key = authScopedStorageKey(KEY, skipper);
        localStorage.setItem(key, '{"id":"run-1"');
        expect(readRunDraft(skipper)).toBeNull();
        localStorage.setItem(key, JSON.stringify({ ...draft, owner_user_id: 'skipper-a', items: [] }));
        expect(readRunDraft(skipper)).toBeNull();
        localStorage.setItem(
            key,
            JSON.stringify({
                ...draft,
                owner_user_id: 'skipper-a',
                items: [{ ...draft.items[0], status: 'maybe' }],
            }),
        );
        expect(readRunDraft(skipper)).toBeNull();
    });

    it('a full or refused store says the run was not kept', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('full', 'QuotaExceededError');
        });
        expect(saveRunDraft(draft, skipper)).toBe(false);
    });

    it('a write that does not read back as written says the run was not kept', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
        expect(saveRunDraft(draft, skipper)).toBe(false);
    });
});
