import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiaryEntryView } from '../components/diary/DiaryEntryView';
import type { DiaryEntry } from '../services/DiaryService';

const mocks = vi.hoisted(() => ({
    ensureEnabled: vi.fn(),
    markEnableRequested: vi.fn(),
    clearEnableRequest: vi.fn(),
    setEntryPublished: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('../services/DiaryService', () => ({
    DiaryService: {
        setEntryPublished: mocks.setEntryPublished,
    },
    MOOD_CONFIG: {
        epic: { emoji: '🌅', label: 'Epic', color: 'text-amber-400' },
        good: { emoji: '⛵', label: 'Good', color: 'text-emerald-400' },
        neutral: { emoji: '🌊', label: 'Neutral', color: 'text-sky-400' },
        rough: { emoji: '💨', label: 'Rough', color: 'text-orange-400' },
        storm: { emoji: '⛈️', label: 'Storm', color: 'text-red-400' },
    },
}));

vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: {
        ensureEnabled: mocks.ensureEnabled,
        ensurePendingEnabled: mocks.ensureEnabled,
        markEnableRequested: mocks.markEnableRequested,
        clearEnableRequest: mocks.clearEnableRequest,
    },
}));

vi.mock('../components/Toast', () => ({
    toast: { error: mocks.toastError },
}));

vi.mock('../components/diary/AudioWidget', () => ({ AudioWidget: () => null }));
vi.mock('../components/diary/DiaryPhoto', () => ({ DiaryPhoto: () => null }));
vi.mock('../components/ui/UndoToast', () => ({ UndoToast: () => null }));

const entry: DiaryEntry = {
    id: 'entry-1',
    user_id: 'user-1',
    title: 'Crossing the bay',
    body: 'A calm afternoon sail.',
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
    created_at: '2026-07-26T08:00:00.000Z',
    updated_at: '2026-07-26T08:00:00.000Z',
};

const renderEntry = (override: Partial<DiaryEntry> = {}) => {
    const onPublishedChange = vi.fn();
    render(
        <DiaryEntryView
            entry={{ ...entry, ...override }}
            isPlaying={false}
            transcribing={false}
            deletedItem={null}
            onBack={vi.fn()}
            onEdit={vi.fn()}
            onTogglePlayback={vi.fn()}
            onTranscribe={vi.fn()}
            onUndo={vi.fn()}
            onDismissDelete={vi.fn()}
            onDelete={vi.fn()}
            onPublishedChange={onPublishedChange}
        />,
    );
    return { onPublishedChange };
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureEnabled.mockResolvedValue({ handle: 'captain', api_key: 'public-key', enabled: true });
    mocks.setEntryPublished.mockResolvedValue(true);
});

describe('DiaryEntryView Voyage Log publishing', () => {
    it("records the skipper's publish intent before waiting for Voyage Log setup", async () => {
        let resolvePublished: ((value: boolean) => void) | undefined;
        mocks.setEntryPublished.mockReturnValue(
            new Promise((resolve) => {
                resolvePublished = resolve;
            }),
        );
        let resolveConfig: ((value: { handle: string; api_key: string; enabled: boolean }) => void) | undefined;
        mocks.ensureEnabled.mockReturnValue(
            new Promise((resolve) => {
                resolveConfig = resolve;
            }),
        );
        const { onPublishedChange } = renderEntry();

        fireEvent.click(screen.getByRole('switch', { name: 'Publish this entry to your voyage log' }));

        await waitFor(() => expect(mocks.setEntryPublished).toHaveBeenCalledWith('entry-1', true));
        expect(mocks.ensureEnabled).not.toHaveBeenCalled();

        await act(async () => {
            resolvePublished?.(true);
        });

        await waitFor(() => expect(mocks.ensureEnabled).toHaveBeenCalledOnce());

        await act(async () => {
            resolveConfig?.({ handle: 'captain', api_key: 'public-key', enabled: true });
        });

        await waitFor(() => expect(onPublishedChange).toHaveBeenCalledWith('entry-1', true));
        expect(mocks.toastError).not.toHaveBeenCalled();
    });

    it('keeps the entry private and explains the pending state when the server cannot confirm publication', async () => {
        mocks.setEntryPublished.mockResolvedValueOnce(false);
        const { onPublishedChange } = renderEntry({ id: 'offline-entry-1' });

        expect(screen.getByText(/still syncing/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('switch', { name: 'Publish this entry to your voyage log' }));

        await waitFor(() =>
            expect(mocks.toastError).toHaveBeenCalledWith(
                expect.stringContaining('could not confirm this entry online, so it has not been published'),
            ),
        );
        expect(mocks.setEntryPublished).toHaveBeenCalledWith('offline-entry-1', true);
        expect(onPublishedChange).not.toHaveBeenCalled();
        expect(screen.getByRole('switch', { name: 'Publish this entry to your voyage log' })).toHaveAttribute(
            'aria-checked',
            'false',
        );
    });

    it('keeps the view private when Voyage Log setup fails after saving publish intent', async () => {
        mocks.ensureEnabled.mockResolvedValueOnce(null);
        const { onPublishedChange } = renderEntry();

        fireEvent.click(screen.getByRole('switch', { name: 'Publish this entry to your voyage log' }));

        await waitFor(() =>
            expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("couldn't prepare your Voyage Log")),
        );
        expect(mocks.setEntryPublished).toHaveBeenCalledWith('entry-1', true);
        expect(onPublishedChange).not.toHaveBeenCalled();
        expect(screen.getByRole('switch', { name: 'Publish this entry to your voyage log' })).toHaveAttribute(
            'aria-checked',
            'false',
        );
    });

    it('confirms an unpublish directly without provisioning a new Voyage Log', async () => {
        const { onPublishedChange } = renderEntry({ is_public: true });

        fireEvent.click(screen.getByRole('switch', { name: 'Publish this entry to your voyage log' }));

        await waitFor(() => expect(mocks.setEntryPublished).toHaveBeenCalledWith('entry-1', false));
        expect(mocks.ensureEnabled).not.toHaveBeenCalled();
        expect(onPublishedChange).toHaveBeenCalledWith('entry-1', false);
    });
});
