import { describe, expect, it } from 'vitest';
import { diaryReducer, initialDiaryState } from '../hooks/useDiaryState';
import { reconcileDiaryEntries, reconcileDiaryRefresh } from '../services/diaryEntryIdentity';
import type { DiaryEntry } from '../services/DiaryService';

const local: DiaryEntry = {
    id: 'offline-123',
    user_id: 'skipper',
    owner_user_id: 'skipper',
    client_operation_id: 'diary_save_123',
    client_revision: 1,
    title: 'At anchor',
    body: 'A lovely afternoon.',
    mood: 'good',
    photos: [],
    audio_url: null,
    latitude: null,
    longitude: null,
    location_name: '',
    weather_summary: '',
    voyage_id: null,
    tags: [],
    is_public: false,
    created_at: '2026-09-20T01:00:00Z',
    updated_at: '2026-09-20T01:00:00Z',
};
const remote = { ...local, id: 'cloud-123' };

describe('diary logical-save reconciliation', () => {
    it('keeps one local/cloud entry before an id mapping exists', () => {
        expect(reconcileDiaryEntries([local, remote])).toEqual([local]);
        expect(reconcileDiaryEntries([remote, local])).toEqual([remote]);
    });
    it('keeps the newer pending edit, even when an older cloud snapshot arrives first', () => {
        const edited = { ...local, client_revision: 2, body: 'Updated after lunch.' };
        expect(reconcileDiaryRefresh([remote], [edited])).toEqual([edited]);
    });
    it('does not combine two deliberate posts with identical text and timestamps', () => {
        const second = { ...local, id: 'offline-456', client_operation_id: 'diary_save_456' };
        expect(reconcileDiaryEntries([local, second])).toEqual([local, second]);
    });
    it('never reconciles identities across owners', () => {
        const anotherOwner = { ...remote, user_id: 'crew', owner_user_id: 'crew' };
        expect(reconcileDiaryEntries([local, anotherOwner], () => remote.id)).toHaveLength(2);
    });
    it('uses legacy id mappings without needing an operation id', () => {
        const legacyLocal = { ...local, client_operation_id: undefined };
        const legacyCloud = { ...remote, client_operation_id: undefined };
        expect(reconcileDiaryRefresh([legacyCloud], [legacyLocal], () => remote.id)).toEqual([legacyCloud]);
    });
    it('joins overlapping legacy and operation aliases regardless of input ordering', () => {
        const legacyCloud = { ...remote, client_operation_id: undefined };
        expect(reconcileDiaryEntries([legacyCloud, local, remote])).toEqual([legacyCloud]);
    });
    it('does not remove a just-saved local entry from a stale poll', () => {
        expect(reconcileDiaryRefresh([], [local])).toEqual([local]);
        expect(reconcileDiaryRefresh([remote], [local])).toEqual([remote]);
    });
    it('does not retain remotely deleted entries through the local-save preservation path', () => {
        expect(reconcileDiaryRefresh([], [remote])).toEqual([]);
    });
    it('repeated save acknowledgements and undo cannot duplicate a reducer entry', () => {
        const state = diaryReducer(initialDiaryState, { type: 'SET_ENTRIES', entries: [remote] });
        const saved = diaryReducer(state, { type: 'PREPEND_ENTRY', entry: local });
        expect(saved.entries).toHaveLength(1);
        expect(diaryReducer(saved, { type: 'RESTORE_ENTRY', entry: remote }).entries).toHaveLength(1);
    });
    it('evaluates batched functional updates against the latest reducer state', () => {
        const second = { ...local, id: 'offline-456', client_operation_id: 'diary_save_456' };
        const first = diaryReducer(initialDiaryState, {
            type: 'SET_ENTRIES',
            entries: (previous) => [local, ...previous],
        });
        const next = diaryReducer(first, { type: 'SET_ENTRIES', entries: (previous) => [second, ...previous] });
        expect(next.entries).toEqual([second, local]);
    });
});
