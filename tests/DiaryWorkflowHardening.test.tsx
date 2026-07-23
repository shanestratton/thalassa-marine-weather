import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiaryEntry } from '../services/DiaryService';
import { generateDiaryPDF } from '../utils/diaryExport';
import { useDiaryState } from '../hooks/useDiaryState';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, setAuthIdentityScope } from '../services/authIdentityScope';

const pdfMocks = vi.hoisted(() => ({
    output: vi.fn(() => new Blob(['pdf'], { type: 'application/pdf' })),
    save: vi.fn(),
}));

vi.mock('jspdf', () => {
    class MockJsPdf {
        GState = class {
            constructor(_options: { opacity: number }) {}
        };
        addImage = vi.fn();
        addPage = vi.fn();
        circle = vi.fn();
        getNumberOfPages = vi.fn(() => 1);
        line = vi.fn();
        output = pdfMocks.output;
        rect = vi.fn();
        roundedRect = vi.fn();
        save = pdfMocks.save;
        setDrawColor = vi.fn();
        setFillColor = vi.fn();
        setFont = vi.fn();
        setFontSize = vi.fn();
        setGState = vi.fn();
        setLineWidth = vi.fn();
        setPage = vi.fn();
        setTextColor = vi.fn();
        splitTextToSize = vi.fn((text: string) => [text]);
        text = vi.fn();
    }

    return { jsPDF: MockJsPdf };
});

const entry = {
    id: 'entry-1',
    user_id: 'user-1',
    title: 'Across the bay',
    body: 'A clean reach in a steady breeze.',
    mood: 'good',
    photos: [],
    audio_url: null,
    latitude: -27.4,
    longitude: 153.1,
    location_name: 'Moreton Bay',
    weather_summary: '15 kt SE',
    weather_data: null,
    voyage_id: null,
    tags: [],
    is_public: false,
    created_at: '2026-07-23T08:00:00.000Z',
    updated_at: '2026-07-23T08:00:00.000Z',
} satisfies DiaryEntry;

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('account-a');
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'share');
    Reflect.deleteProperty(navigator, 'canShare');
});

describe('diary workflow hardening', () => {
    it('sets and clears the complete diary selection atomically', () => {
        const { result } = renderHook(() => useDiaryState());

        act(() => {
            result.current.dispatch({ type: 'SET_SELECTED_IDS', ids: new Set(['one', 'two']) });
        });
        expect(result.current.state.selectMode).toBe(true);
        expect([...result.current.state.selectedIds]).toEqual(['one', 'two']);

        act(() => {
            result.current.dispatch({ type: 'SET_SELECTED_IDS', ids: new Set() });
        });
        expect(result.current.state.selectMode).toBe(false);
        expect(result.current.state.selectedIds.size).toBe(0);
    });

    it('forces a download when the Download action is chosen', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        Object.defineProperties(navigator, {
            share: { configurable: true, value: share },
            canShare: { configurable: true, value: vi.fn(() => true) },
        });

        await generateDiaryPDF([entry], undefined, 'Shane', 'download');

        expect(pdfMocks.save).toHaveBeenCalledOnce();
        expect(share).not.toHaveBeenCalled();
    });

    it('uses file sharing when the Share action is chosen and supported', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        Object.defineProperties(navigator, {
            share: { configurable: true, value: share },
            canShare: { configurable: true, value: vi.fn(() => true) },
        });

        await generateDiaryPDF([entry], undefined, 'Shane', 'share');

        expect(share).toHaveBeenCalledOnce();
        expect(pdfMocks.save).not.toHaveBeenCalled();
    });

    it('does not deliver account-A diary content after the identity changes during photo loading', async () => {
        let resolvePhoto!: (value: { ok: boolean; blob: () => Promise<Blob> }) => void;
        const fetchMock = vi.fn(
            () =>
                new Promise<{ ok: boolean; blob: () => Promise<Blob> }>((resolve) => {
                    resolvePhoto = resolve;
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const operationScope = getAuthIdentityScope();
        const onSuccess = vi.fn();
        const exportPromise = generateDiaryPDF(
            [{ ...entry, photos: ['https://private.example/account-a.jpg'] }],
            {
                shouldContinue: () => isAuthIdentityScopeCurrent(operationScope),
                onSuccess,
            },
            'Shane',
            'download',
        );

        await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        act(() => {
            setAuthIdentityScope('account-b');
        });
        resolvePhoto({
            ok: true,
            blob: () => Promise.resolve(new Blob(['photo'], { type: 'image/jpeg' })),
        });
        await exportPromise;

        expect(pdfMocks.save).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
    });
});
