import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { ShipLogEntry } from '../types';

const mocks = vi.hoisted(() => ({
    getLogEntries: vi.fn(),
    importGPXVoyage: vi.fn(),
    shareTrack: vi.fn(),
    deleteSharedTrack: vi.fn(),
    downloadTrack: vi.fn(),
    importGPXToEntries: vi.fn(),
    sendMessage: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getLogEntries: mocks.getLogEntries,
        importGPXVoyage: mocks.importGPXVoyage,
    },
}));

vi.mock('../services/TrackSharingService', () => ({
    TrackSharingService: {
        shareTrack: mocks.shareTrack,
        deleteSharedTrack: mocks.deleteSharedTrack,
        downloadTrack: mocks.downloadTrack,
    },
}));

vi.mock('../services/gpxService', () => ({
    importGPXToEntries: mocks.importGPXToEntries,
}));

vi.mock('../services/ChatService', () => ({
    ChatService: {
        sendMessage: mocks.sendMessage,
    },
}));

vi.mock('../components/Toast', () => ({
    toast: {
        error: mocks.toastError,
        info: mocks.toastInfo,
    },
}));

import { useTrackSharing, type VoyageSummary } from '../hooks/chat/useTrackSharing';
import type { ChatMessage } from '../services/ChatService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const entry = (id: string, timestamp: number): ShipLogEntry => ({
    id,
    userId: 'account-a',
    voyageId: 'voyage-a',
    latitude: -27,
    longitude: 153,
    positionFormatted: '27°00.000′S 153°00.000′E',
    timestamp: new Date(timestamp).toISOString(),
    entryType: 'auto',
    distanceNM: 1,
    cumulativeDistanceNM: id === 'entry-2' ? 2 : 1,
    source: 'device',
});

const voyage: VoyageSummary = {
    voyageId: 'voyage-a',
    entryCount: 2,
    distance: 2,
    startTime: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    endTime: new Date('2026-01-01T01:00:00.000Z').toISOString(),
    entries: [entry('entry-1', 1), entry('entry-2', 2)],
};

function renderTrackSharing(setMessages = vi.fn() as React.Dispatch<React.SetStateAction<ChatMessage[]>>) {
    return renderHook(() =>
        useTrackSharing({
            activeChannel: { id: 'channel-1' },
            setMessages,
            messageEndRef: { current: null },
            setShowAttachMenu: vi.fn(),
        }),
    );
}

describe('useTrackSharing identity isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.getLogEntries.mockResolvedValue([]);
        mocks.importGPXVoyage.mockResolvedValue({ savedCount: 1 });
        mocks.shareTrack.mockResolvedValue(null);
        mocks.deleteSharedTrack.mockResolvedValue(true);
        mocks.downloadTrack.mockResolvedValue(null);
        mocks.importGPXToEntries.mockReturnValue([entry('imported', 1)]);
        mocks.sendMessage.mockResolvedValue({
            id: 'sent-message',
            channel_id: 'channel-1',
            user_id: 'account-a',
            display_name: 'Sailor',
            message: 'sent',
            is_question: false,
            helpful_count: 0,
            is_pinned: false,
            deleted_at: null,
            created_at: '2026-07-24T00:00:00.000Z',
        });
    });

    it('synchronously hides A picker state and drops its deferred voyage result', async () => {
        const entries = deferred<ShipLogEntry[]>();
        mocks.getLogEntries.mockReturnValue(entries.promise);
        const { result } = renderTrackSharing();

        let pending!: Promise<void>;
        act(() => {
            pending = result.current.openTrackPicker();
        });
        expect(result.current.showTrackPicker).toBe(true);
        expect(result.current.trackLoadingVoyages).toBe(true);

        act(() => setAuthIdentityScope('account-b'));
        expect(result.current.showTrackPicker).toBe(false);
        expect(result.current.trackLoadingVoyages).toBe(false);
        expect(result.current.voyageList).toEqual([]);

        entries.resolve([entry('entry-1', 1), entry('entry-2', 2)]);
        await act(async () => pending);

        expect(result.current.voyageList).toEqual([]);
        expect(result.current.trackLoadingVoyages).toBe(false);
    });

    it('does not let A sharing completion or finally overwrite an in-flight B share', async () => {
        const sharedA = deferred<{ id: string } | null>();
        const sharedB = deferred<{ id: string } | null>();
        mocks.shareTrack.mockReturnValueOnce(sharedA.promise).mockReturnValueOnce(sharedB.promise);
        const setMessages = vi.fn() as React.Dispatch<React.SetStateAction<ChatMessage[]>>;
        const { result } = renderTrackSharing(setMessages);

        let pendingA!: Promise<void>;
        act(() => {
            pendingA = result.current.sendTrack(voyage);
        });
        expect(result.current.trackSharing).toBe(true);

        act(() => setAuthIdentityScope('account-b'));
        let pendingB!: Promise<void>;
        act(() => {
            pendingB = result.current.sendTrack({ ...voyage, voyageId: 'voyage-b' });
        });
        expect(result.current.trackSharing).toBe(true);

        sharedA.resolve({ id: 'track-a' });
        await act(async () => pendingA);
        expect(result.current.trackSharing).toBe(true);
        expect(setMessages).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();

        sharedB.resolve({ id: 'track-b' });
        await act(async () => pendingB);
        expect(result.current.trackSharing).toBe(false);
        expect(setMessages).toHaveBeenCalledTimes(2);
        expect(mocks.sendMessage).toHaveBeenCalledWith('channel-1', expect.stringContaining('track-b'), false);
    });

    it('makes a queued account-A optimistic updater a no-op against B messages', async () => {
        const sent = deferred<void>();
        mocks.shareTrack.mockResolvedValue({ id: 'track-a' });
        mocks.sendMessage.mockReturnValue(sent.promise);
        const setMessagesMock = vi.fn();
        const setMessages = setMessagesMock as React.Dispatch<React.SetStateAction<ChatMessage[]>>;
        const { result } = renderTrackSharing(setMessages);

        let pending!: Promise<void>;
        act(() => {
            pending = result.current.sendTrack(voyage);
        });
        await vi.waitFor(() => expect(setMessagesMock).toHaveBeenCalledOnce());
        const updater = setMessagesMock.mock.calls[0][0] as (messages: ChatMessage[]) => ChatMessage[];

        act(() => setAuthIdentityScope('account-b'));
        const accountBMessages = [{ id: 'b-message', message: 'B private' } as ChatMessage];
        expect(updater(accountBMessages)).toBe(accountBMessages);

        sent.resolve();
        await act(async () => pending);
    });

    it('removes a failed optimistic post and deletes the orphaned shared track', async () => {
        mocks.shareTrack.mockResolvedValue({ id: 'track-a' });
        mocks.sendMessage.mockResolvedValue(null);
        const setMessagesMock = vi.fn();
        const { result } = renderTrackSharing(setMessagesMock as React.Dispatch<React.SetStateAction<ChatMessage[]>>);

        await act(() => result.current.sendTrack(voyage));

        const finalMessages = setMessagesMock.mock.calls.reduce<ChatMessage[]>((messages, [update]) => {
            return typeof update === 'function' ? update(messages) : update;
        }, []);
        expect(finalMessages).toEqual([]);
        expect(mocks.deleteSharedTrack).toHaveBeenCalledWith('track-a');
        expect(result.current.showTrackPicker).toBe(true);
        expect(mocks.toastError).toHaveBeenCalledWith("The track couldn't be posted to chat. Please try again.");
    });

    it('marks a durably queued track post instead of pretending it was delivered', async () => {
        mocks.shareTrack.mockResolvedValue({ id: 'track-a' });
        mocks.sendMessage.mockResolvedValue('queued');
        const setMessagesMock = vi.fn();
        const { result } = renderTrackSharing(setMessagesMock as React.Dispatch<React.SetStateAction<ChatMessage[]>>);

        await act(() => result.current.sendTrack(voyage));

        const finalMessages = setMessagesMock.mock.calls.reduce<ChatMessage[]>((messages, [update]) => {
            return typeof update === 'function' ? update(messages) : update;
        }, []);
        expect(finalMessages).toHaveLength(1);
        expect(finalMessages[0].delivery_status).toBe('queued');
        expect(mocks.deleteSharedTrack).not.toHaveBeenCalled();
        expect(mocks.toastInfo).toHaveBeenCalledWith('Track post queued — it will send when the connection returns.');
    });

    it('keeps B import state intact when account A download resolves late', async () => {
        const downloadA = deferred<string | null>();
        const downloadB = deferred<string | null>();
        mocks.downloadTrack.mockReturnValueOnce(downloadA.promise).mockReturnValueOnce(downloadB.promise);
        const { result } = renderTrackSharing();

        let pendingA!: Promise<void>;
        act(() => {
            pendingA = result.current.handleImportTrack('track-a', 'A secret');
        });
        expect(result.current.importingTrackId).toBe('track-a');

        act(() => setAuthIdentityScope('account-b'));
        let pendingB!: Promise<void>;
        act(() => {
            pendingB = result.current.handleImportTrack('track-b', 'B track');
        });
        expect(result.current.importingTrackId).toBe('track-b');

        downloadA.resolve('<gpx>A</gpx>');
        await act(async () => pendingA);
        expect(result.current.importingTrackId).toBe('track-b');
        expect(mocks.importGPXToEntries).not.toHaveBeenCalled();

        downloadB.resolve('<gpx>B</gpx>');
        await act(async () => pendingB);
        expect(result.current.importingTrackId).toBeNull();
        expect(result.current.trackImportStatus).toContain('B track');
        expect(mocks.importGPXVoyage).toHaveBeenCalledOnce();
    });

    it('rejects a retained account-A disclaimer setter after switching to B', () => {
        const { result } = renderTrackSharing();
        const accountASetter = result.current.setShowTrackDisclaimer;

        act(() => setAuthIdentityScope('account-b'));
        act(() => accountASetter({ trackId: 'track-a', title: 'A secret' }));

        expect(result.current.showTrackDisclaimer).toBeNull();
    });
});
