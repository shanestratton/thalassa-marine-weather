/**
 * WarningDetails — the Forecast alerts page.
 *
 * UX scorecard run 7: the clear state sent the skipper to "BoM marine
 * warnings" as plain text, a dead end. It is a real link opened over the app,
 * and the page's answer is a heading so heading navigation reaches it.
 *
 * Build 123 (W1-02): these are Thalassa's own forecast checks, so every card
 * says so, and the onward link goes to the official issuer for the boat's
 * position anywhere in the world (a boat in the Med is no longer sent to BOM).
 * One classifier decides what is critical on every alerts surface, and the
 * legacy 'GALE WARNING' strings in cached reports stay non-dismissable.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setPage: vi.fn(), openExternalUrl: vi.fn(async () => undefined) }));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: mocks.setPage }),
}));
vi.mock('../services/externalLinks', () => ({ openExternalUrl: mocks.openExternalUrl }));

import { WarningDetails } from '../components/WarningDetails';
import { CompactHeaderRow } from '../components/dashboard/CompactHeaderRow';
import { AlertsBanner } from '../components/dashboard/WeatherGrid_exports';
import { OFFICIAL_WARNINGS_SOURCES } from '../utils/officialWarningsSource';

const DISMISSED_KEY = 'thalassa_dismissed_alerts';
const GLADSTONE = { lat: -23.85, lon: 151.25 };
const MARSEILLE = { lat: 43.3, lon: 5.37 };
const MID_ATLANTIC = { lat: 30, lon: -40 };

beforeEach(() => {
    sessionStorage.clear();
    mocks.openExternalUrl.mockClear();
});
afterEach(cleanup);

describe('WarningDetails clear state', () => {
    it('names the place in a heading and links to the Bureau for an Australian position', () => {
        render(
            <WarningDetails
                alerts={[]}
                placeName="Gladstone"
                coordinates={GLADSTONE}
                checkedAt={new Date().toISOString()}
            />,
        );

        // The page title stays 'Forecast alerts'.
        expect(screen.getByRole('heading', { level: 1, name: 'Forecast alerts' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'No forecast alerts for Gladstone' })).toBeInTheDocument();
        expect(screen.getByText(/check the Bureau of Meteorology’s warnings too/)).toBeInTheDocument();

        const link = screen.getByRole('link', { name: /Open BoM warnings/ });
        expect(link).toHaveAttribute('href', OFFICIAL_WARNINGS_SOURCES.bom.url);
        expect(link.className).toContain('min-h-[44px]');
        // The link is a control, so it sits outside the status region.
        expect(screen.getByRole('status')).not.toContainElement(link);

        fireEvent.click(link);
        expect(mocks.openExternalUrl).toHaveBeenCalledWith(OFFICIAL_WARNINGS_SOURCES.bom.url);
    });

    it('sends a boat in the Med to MeteoAlarm, never to the Bureau', () => {
        render(<WarningDetails alerts={[]} placeName="Marseille" coordinates={MARSEILLE} locationType="coastal" />);

        const link = screen.getByRole('link', { name: /Open MeteoAlarm warnings/ });
        expect(link).toHaveAttribute('href', OFFICIAL_WARNINGS_SOURCES.meteoalarm.url);
        expect(screen.getByText(/check the national warnings on MeteoAlarm too/)).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/Bureau|BoM/);

        fireEvent.click(link);
        expect(mocks.openExternalUrl).toHaveBeenCalledWith(OFFICIAL_WARNINGS_SOURCES.meteoalarm.url);
    });

    it('sends an offshore boat outside national waters to its METAREA warnings', () => {
        render(<WarningDetails alerts={[]} coordinates={MID_ATLANTIC} locationType="offshore" />);
        const link = screen.getByRole('link', { name: /Open METAREA warnings/ });
        expect(link).toHaveAttribute('href', OFFICIAL_WARNINGS_SOURCES['wmo-wwmiws'].url);
    });

    it('without a position, points to the WMO list of national warnings rather than any one country', () => {
        render(<WarningDetails alerts={[]} />);
        const link = screen.getByRole('link', { name: /Open WMO warnings/ });
        expect(link).toHaveAttribute('href', OFFICIAL_WARNINGS_SOURCES['wmo-swic'].url);
        expect(document.body.textContent).not.toMatch(/Bureau|BoM/);
    });

    it('offers no link while alerts are listed', () => {
        render(<WarningDetails alerts={['Gale warning for coastal waters']} coordinates={GLADSTONE} />);
        expect(screen.queryByRole('link', { name: /Open .* warnings/ })).not.toBeInTheDocument();
    });
});

describe('WarningDetails cards', () => {
    it('says on every card that it is Thalassa’s own forecast check, with the model', () => {
        render(
            <WarningDetails
                alerts={['Forecast: gale-force wind, 34 kt+', 'Forecast: heavy rain, visibility reduced']}
                modelUsed="wx:ecmwf_ifs025"
                coordinates={GLADSTONE}
            />,
        );
        const lines = screen.getAllByText('Thalassa forecast check · ECMWF · not an official warning');
        expect(lines).toHaveLength(2);
    });

    // A card names a model only where the tag can vouch that the model
    // raised it; otherwise it still says it is not an official warning.
    const cardLine = (alert: string) => {
        const text = screen.getByText(alert);
        return text.parentElement?.querySelector('p.text-sm')?.textContent;
    };

    it('names no model on any card of a fallback blend or the Spitfire overlay', () => {
        // blendOffshoreForecast merges the fallback report's alerts; the tag
        // still resolves to ECMWF for the Glass pill.
        render(
            <WarningDetails
                alerts={['Forecast: gale-force wind, 34 kt+', 'Forecast: dense fog, visibility under 1 nm']}
                modelUsed="stormglass_ecmwf+fallback:openmeteo_best_match"
            />,
        );
        expect(cardLine('Forecast: gale-force wind, 34 kt+')).toBe('Thalassa forecast check · not an official warning');
        expect(cardLine('Forecast: dense fog, visibility under 1 nm')).toBe(
            'Thalassa forecast check · not an official warning',
        );
        cleanup();

        // Spitfire rewrites the wind after the base report raised its alerts.
        render(<WarningDetails alerts={['Forecast: gale-force wind, 34 kt+']} modelUsed="spitfire+sg" />);
        expect(cardLine('Forecast: gale-force wind, 34 kt+')).toBe('Thalassa forecast check · not an official warning');
    });

    it('names no model on sea-state cards, on borrowed visibility and UV, or on legacy texts', () => {
        render(
            <WarningDetails
                alerts={[
                    'Forecast: gale-force wind, 34 kt+',
                    'Forecast: rough seas, 8 ft+ (2.4 m)',
                    'Forecast: dense fog, visibility under 1 nm',
                    'Forecast: very high UV, protection needed',
                    'GALE WARNING: Winds exceeding 34kts',
                ]}
                modelUsed="om:dwd_icon+wk"
            />,
        );
        expect(cardLine('Forecast: gale-force wind, 34 kt+')).toBe(
            'Thalassa forecast check · ICON · not an official warning',
        );
        for (const alert of [
            'Forecast: rough seas, 8 ft+ (2.4 m)', // a wave model, not ICON
            'Forecast: dense fog, visibility under 1 nm', // borrowed from WeatherKit
            'Forecast: very high UV, protection needed', // borrowed from WeatherKit
            'GALE WARNING: Winds exceeding 34kts', // a cached report's legacy text
        ]) {
            expect(cardLine(alert), alert).toBe('Thalassa forecast check · not an official warning');
        }
        cleanup();

        // Without '+wk' the model forecast the visibility itself.
        render(<WarningDetails alerts={['Forecast: dense fog, visibility under 1 nm']} modelUsed="wx:dwd_icon" />);
        expect(cardLine('Forecast: dense fog, visibility under 1 nm')).toBe(
            'Thalassa forecast check · ICON · not an official warning',
        );
    });

    it('leaves out a model name it cannot stand behind (blends, loading)', () => {
        for (const modelUsed of ['wk', 'rb+om', 'Loading...', undefined]) {
            render(<WarningDetails alerts={['Forecast: strong wind, 22 kt+']} modelUsed={modelUsed} />);
            expect(screen.getByText('Thalassa forecast check · not an official warning')).toBeInTheDocument();
            cleanup();
        }
    });

    it('keeps critical alerts, new and legacy, non-dismissable; cautions dismiss into the same session key', () => {
        render(
            <WarningDetails
                alerts={[
                    'Forecast: gale-force wind, 34 kt+',
                    'GALE WARNING: Winds exceeding 34kts',
                    'Forecast: rough seas, 8 ft+ (2.4 m)',
                ]}
            />,
        );
        expect(screen.queryByRole('button', { name: /Dismiss forecast alert: Forecast: gale-force/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Dismiss forecast alert: GALE WARNING/ })).toBeNull();
        expect(screen.getAllByText('Critical')).toHaveLength(2);

        fireEvent.click(
            screen.getByRole('button', { name: 'Dismiss forecast alert: Forecast: rough seas, 8 ft+ (2.4 m)' }),
        );
        expect(JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]')).toEqual([
            'Forecast: rough seas, 8 ft+ (2.4 m)',
        ]);
        expect(screen.queryByText('Forecast: rough seas, 8 ft+ (2.4 m)')).toBeNull();
        expect(screen.getByText('Forecast: gale-force wind, 34 kt+')).toBeInTheDocument();
    });

    it('never hides a critical alert a stale session marked dismissed', () => {
        sessionStorage.setItem(
            DISMISSED_KEY,
            JSON.stringify(['Forecast: gale-force wind, 34 kt+', 'GALE WARNING: Winds exceeding 34kts']),
        );
        render(
            <WarningDetails alerts={['Forecast: gale-force wind, 34 kt+', 'GALE WARNING: Winds exceeding 34kts']} />,
        );
        expect(screen.getByText('Forecast: gale-force wind, 34 kt+')).toBeInTheDocument();
        expect(screen.getByText('GALE WARNING: Winds exceeding 34kts')).toBeInTheDocument();
    });
});

describe('every alerts surface shares the one classifier', () => {
    beforeEach(() => {
        sessionStorage.setItem(
            DISMISSED_KEY,
            JSON.stringify([
                'Forecast: gale-force wind, 34 kt+',
                'GALE WARNING: Winds exceeding 34kts',
                'Forecast: strong wind, 22 kt+',
            ]),
        );
    });

    it('the Glass pill counts dismissed gales but not dismissed cautions, and says forecast alerts', () => {
        render(
            <CompactHeaderRow
                alerts={[
                    'Forecast: gale-force wind, 34 kt+',
                    'GALE WARNING: Winds exceeding 34kts',
                    'Forecast: strong wind, 22 kt+',
                ]}
            />,
        );
        const pill = screen.getByRole('button', { name: '2 active forecast alerts' });
        expect(within(pill).getByText('Alerts')).toBeInTheDocument();
        expect(pill.textContent).not.toMatch(/warning/i);
    });

    it('the alerts banner does the same', () => {
        render(
            <AlertsBanner
                alerts={[
                    'Forecast: gale-force wind, 34 kt+',
                    'GALE WARNING: Winds exceeding 34kts',
                    'Forecast: strong wind, 22 kt+',
                ]}
            />,
        );
        expect(screen.getByRole('button', { name: 'View 2 forecast alerts' })).toBeInTheDocument();
    });
});
