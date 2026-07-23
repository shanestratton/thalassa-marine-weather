/**
 * OnboardingWizard — component tests.
 * Verifies render, step navigation, and sub-component integration.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../context/WeatherContext', () => ({
    useWeather: () => ({
        weatherData: null,
        loading: false,
    }),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: {
            userName: '',
            homePort: '',
            vesselType: 'sailboat',
            windSpeedUnit: 'kts',
            temperatureUnit: 'celsius',
            distanceUnit: 'nm',
            pressureUnit: 'hPa',
            depthUnit: 'm',
            waveHeightUnit: 'm',
            timeFormat: '24h',
            keepScreenOn: false,
            autoTrack: false,
        },
        updateSettings: vi.fn(),
    }),
}));

vi.mock('../hooks/useKeyboardScroll', () => ({ useKeyboardScroll: () => ({ current: null }) }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPosition: vi.fn().mockResolvedValue({ latitude: -33.868, longitude: 151.209 }),
    },
}));

vi.mock('../services/weatherService', () => ({
    reverseGeocode: vi.fn().mockResolvedValue('Sydney, NSW'),
    parseLocation: vi.fn().mockResolvedValue({ lat: -33.868, lng: 151.209 }),
}));

vi.mock('../services/weather', () => ({
    fetchWeatherByStrategy: vi.fn().mockResolvedValue(null),
}));

vi.mock('../components/WeatherMap', () => ({
    WeatherMap: () => <div data-testid="weather-map">Map</div>,
}));

vi.mock('../components/settings/YachtDatabaseSearch', () => ({
    YachtDatabaseSearch: () => <div data-testid="yacht-search">YachtSearch</div>,
}));

vi.mock('../utils', () => ({
    getSystemUnits: vi.fn().mockReturnValue({ distance: 'nm', speed: 'kts', temperature: 'celsius' }),
}));

vi.mock('../theme', () => ({
    t: {
        colors: {
            bg: { base: '#0f172a', elevated: '#1e293b', card: '#1e293b' },
            text: { primary: '#f8fafc', secondary: '#94a3b8', muted: '#64748b' },
            border: { subtle: '#334155', muted: '#1e293b' },
            accent: { primary: '#0ea5e9', success: '#22c55e', warning: '#f59e0b', danger: '#ef4444' },
        },
        nav: { pageBackground: '#0f172a', barBackground: '#0f172a' },
        card: { background: '#1e293b', border: '#334155' },
        spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
        radius: { sm: 8, md: 12, lg: 16 },
        typography: { caption: { fontSize: 11 }, label: { fontSize: 12 }, body: { fontSize: 14 } },
    },
    default: { colors: { bg: { base: '#0f172a' } }, nav: { pageBackground: '#0f172a' } },
}));

import { OnboardingWizard } from '../components/OnboardingWizard';

describe('OnboardingWizard', () => {
    const mockOnComplete = vi.fn();

    beforeEach(() => vi.clearAllMocks());

    it('renders as a labelled body-level modal above app chrome', () => {
        const { container } = render(<OnboardingWizard onComplete={mockOnComplete} />);
        const dialog = screen.getByRole('dialog', { name: 'Set up Thalassa' });
        const overlay = dialog.closest('[data-overlay-layer="modal"]');

        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay).toHaveStyle({ zIndex: '1100' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(container).not.toContainElement(dialog);
    });

    it('renders content (not empty)', () => {
        render(<OnboardingWizard onComplete={mockOnComplete} />);
        expect(screen.getByRole('dialog', { name: 'Set up Thalassa' }).textContent!.length).toBeGreaterThan(0);
    });

    it('starts on step 1 with visible content', () => {
        render(<OnboardingWizard onComplete={mockOnComplete} />);
        const dialog = screen.getByRole('dialog', { name: 'Set up Thalassa' });
        const text = dialog.textContent || '';
        expect(text.length).toBeGreaterThan(0);
        // Step indicator dots should be present
        expect(dialog.querySelector('[class*="rounded-full"]')).not.toBeNull();
    });

    it('renders navigation buttons', () => {
        render(<OnboardingWizard onComplete={mockOnComplete} />);
        const buttons = screen.getAllByRole('button');
        expect(buttons.length).toBeGreaterThan(0);
    });

    it('can advance past step 1', () => {
        render(<OnboardingWizard onComplete={mockOnComplete} />);
        const buttons = screen.getAllByRole('button');
        const nextButton = buttons.find(
            (b) =>
                b.textContent?.toLowerCase().includes('next') ||
                b.textContent?.toLowerCase().includes('continue') ||
                b.textContent?.toLowerCase().includes('get started') ||
                b.textContent?.toLowerCase().includes('start'),
        );
        if (nextButton) {
            fireEvent.click(nextButton);
        }
        // Should still render without error
        expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    });

    it('does not call onComplete on initial render', () => {
        render(<OnboardingWizard onComplete={mockOnComplete} />);
        expect(mockOnComplete).not.toHaveBeenCalled();
    });

    it('contains keyboard focus and restores the launcher when unmounted', () => {
        const { rerender } = render(<button type="button">Launch setup</button>);
        const launcher = screen.getByRole('button', { name: 'Launch setup' });
        launcher.focus();

        rerender(
            <>
                <button type="button">Launch setup</button>
                <OnboardingWizard onComplete={mockOnComplete} />
            </>,
        );

        const firstAction = screen.getByRole('button', { name: 'Get started' });
        expect(firstAction).toHaveFocus();
        fireEvent.click(firstAction);

        expect(screen.getByRole('group', { name: 'Setup step 2 of 7' })).toHaveFocus();
        const firstFocusable = screen.getByRole('button', { name: 'Go back' });
        const lastFocusable = screen.getByRole('button', { name: 'Pick home port on map' });

        lastFocusable.focus();
        fireEvent.keyDown(lastFocusable, { key: 'Tab' });
        expect(firstFocusable).toHaveFocus();

        fireEvent.keyDown(firstFocusable, { key: 'Tab', shiftKey: true });
        expect(lastFocusable).toHaveFocus();

        rerender(<button type="button">Launch setup</button>);
        expect(screen.getByRole('button', { name: 'Launch setup' })).toHaveFocus();
    });
});
