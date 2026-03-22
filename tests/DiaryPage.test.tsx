/**
 * DiaryPage — component tests.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: {
            locationName: 'Brisbane',
            windSpeed: 10,
            windDirection: 'E',
            waveHeight: 0.3,
            airTemperature: 25,
            condition: 'Sunny',
        },
        loading: false,
    }),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { units: { speed: 'kts', temp: 'C', length: 'ft' }, isPro: true },
        updateSettings: vi.fn(),
    }),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
}));

vi.mock('../services/DiaryService', () => ({
    DiaryService: {
        getEntries: vi.fn().mockResolvedValue([]),
        createEntry: vi.fn(),
        deleteEntry: vi.fn(),
        updateEntry: vi.fn(),
    },
    DiaryMood: {},
}));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: { getConfig: vi.fn().mockReturnValue(null) },
}));

vi.mock('../components/ui/SlideToAction', () => ({
    SlideToAction: ({ label }: { label: string }) => <button data-testid="slide-to-action">{label}</button>,
}));
vi.mock('../components/ui/PageHeader', () => ({
    PageHeader: ({ title, onBack }: { title: string; onBack: () => void }) => (
        <div data-testid="page-header">
            <button onClick={onBack} data-testid="back-button">
                Back
            </button>
            <span>{title}</span>
        </div>
    ),
}));
vi.mock('../components/ui/UndoToast', () => ({ UndoToast: () => null }));
vi.mock('../components/diary/SwipeableDiaryCard', () => ({
    SwipeableDiaryCard: ({ entry }: { entry: { id: string; title: string } }) => (
        <div data-testid={`diary-${entry.id}`}>{entry.title}</div>
    ),
}));
vi.mock('../components/diary/DiaryEntryView', () => ({ DiaryEntryView: () => null }));
vi.mock('../components/diary/DiaryComposeForm', () => ({
    DiaryComposeForm: () => <div data-testid="compose-form">ComposeForm</div>,
}));

vi.mock('../hooks/useDiaryState', () => ({
    useDiaryState: () => ({
        state: {
            entries: [
                {
                    id: 'd1',
                    title: 'Beautiful sunset',
                    body: 'Watched the sun go down.',
                    mood: 'happy',
                    created_at: '2026-03-20T18:00:00Z',
                    photos: [],
                },
                {
                    id: 'd2',
                    title: 'Engine trouble',
                    body: 'Had to replace the impeller.',
                    mood: 'worried',
                    created_at: '2026-03-21T09:00:00Z',
                    photos: [],
                },
            ],
            loading: false,
            composing: false,
            viewingEntry: null,
            deleteConfirm: null,
            deletedEntry: null,
            selectedIds: new Set(),
            selectionMode: false,
        },
        dispatch: vi.fn(),
    }),
}));

import { DiaryPage } from '../components/DiaryPage';

describe('DiaryPage', () => {
    const onBack = vi.fn();
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<DiaryPage onBack={onBack} />);
        expect(container).toBeDefined();
    });

    it('renders content (not empty)', () => {
        const { container } = render(<DiaryPage onBack={onBack} />);
        expect(container.textContent!.length).toBeGreaterThan(0);
    });

    it('displays diary entries when they exist', () => {
        render(<DiaryPage onBack={onBack} />);
        expect(screen.getByText('Beautiful sunset')).toBeDefined();
        expect(screen.getByText('Engine trouble')).toBeDefined();
    });

    it('renders page header with back navigation', () => {
        render(<DiaryPage onBack={onBack} />);
        expect(screen.getByTestId('page-header')).toBeDefined();
    });

    it('does not throw on repeated renders', () => {
        expect(() => {
            const { rerender } = render(<DiaryPage onBack={onBack} />);
            rerender(<DiaryPage onBack={onBack} />);
        }).not.toThrow();
    });
});
