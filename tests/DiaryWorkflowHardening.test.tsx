import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiaryEntry } from '../services/DiaryService';
import { generateDiaryPDF } from '../utils/diaryExport';
import { useDiaryState } from '../hooks/useDiaryState';

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
    title: 'Across the bay',
    body: 'A clean reach in a steady breeze.',
    mood: 'good',
    photos: [],
    latitude: -27.4,
    longitude: 153.1,
    location_name: 'Moreton Bay',
    weather_summary: '15 kt SE',
    weather_data: null,
    created_at: '2026-07-23T08:00:00.000Z',
} as DiaryEntry;

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
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
});
