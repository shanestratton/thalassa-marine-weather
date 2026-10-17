import React from 'react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
const feed = vi.hoisted(() => ({ status: 'closed' as 'open' | 'closed', listeners: new Set<(v: unknown) => void>() }));
vi.mock('../services/weather/api/blitzortungLightning', () => ({
    subscribeLightningStatus: (fn: (v: unknown) => void) => {
        fn({
            status: feed.status,
            lastStrikeAt: 0,
            strikesReceived: 0,
            strikesPerMinute: 0,
            viewportRate: 0,
            viewportCount: 0,
            currentServer: '',
            retryAttempts: 0,
        });
        feed.listeners.add(fn);
        return () => {
            feed.listeners.delete(fn);
        };
    },
}));
vi.mock('../services/externalLinks', () => ({ openExternalUrl: vi.fn(async () => {}) }));
import { openExternalUrl } from '../services/externalLinks';
import { publishAisCoverage } from '../services/ais/aisCoverage';
import { SAT_IR_FULL_COVERAGE } from '../components/map/satelliteImagery';
import ObsCreditsRollup, { type ObsCreditsRollupProps } from '../components/map/ObsCreditsRollup';
const now = 1792137600000;
function props(): ObsCreditsRollupProps {
    return {
        rain: 'radar',
        wind: 'Wind: ECMWF (CC BY 4.0) via Open-Meteo',
        cmems: ['currents', 'waves', 'chl'],
        lightning: false,
        ais: true,
        satellite: {
            status: 'ready',
            frameTimeMs: now - 3600000,
            frameCount: 4,
            coverage: SAT_IR_FULL_COVERAGE,
            playing: false,
            following: false,
        },
        onToggleSatellite: vi.fn(),
    };
}
it('adds relief datum/source details inside the same row and only when the relief base is selected', () => {
    const p = props();
    p.rain = null;
    p.wind = null;
    p.cmems = [];
    p.ais = false;
    p.satellite.status = 'off';
    p.relief = true;
    const view = render(<ObsCreditsRollup {...p} />);
    expect(screen.getAllByTestId('obs-credits-rollup')).toHaveLength(1);
    expect(screen.getByTestId('obs-credits-rollup').className).toContain('h-[44px]');
    fireEvent.click(screen.getByRole('button', { name: /^Credits$/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('NZVD2016 native heights; not MSL');
    expect(dialog).toHaveTextContent('No vertical conversion');
    expect(dialog).toHaveTextContent('not whole-country');
    expect(within(dialog).getByRole('link', { name: 'New Zealand · 61 surveyed coastal patches' })).toHaveAttribute(
        'href',
        'https://data.linz.govt.nz/layer/122508-new-zealand-coastal-lidar-1m-dem/',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /^Close$/ }));
    view.rerender(<ObsCreditsRollup {...p} relief={false} />);
    expect(screen.queryByTestId('obs-credits-rollup')).toBeNull();
});
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    feed.status = 'closed';
    publishAisCoverage({ state: 'recent', polledAt: new Date(now - 60000).toISOString(), truncated: false });
});
it('holds new atmospheric credits and uncertainty inside the same one-row rollup', () => {
    const p = props();
    p.atmosphere = [
        {
            key: 'gfs',
            title: 'GFS atmospheric fields',
            text: 'NOAA / NCEP GFS. Model visibility, low skill. Original run and valid UTC.',
            warning: true,
        },
    ];
    render(<ObsCreditsRollup {...p} />);
    expect(screen.getAllByTestId('obs-credits-rollup')).toHaveLength(1);
    expect(screen.queryByText('GFS atmospheric fields')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Credits; layer status needs review' }));
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveTextContent('Model visibility, low skill');
    expect(screen.getByRole('region', { name: 'GFS atmospheric fields' })).toBeInTheDocument();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
it('five active source groups occupy one row; full names/licences/DOIs and original frame time stay accessible', () => {
    const p = props();
    render(<ObsCreditsRollup {...p} />);
    const row = screen.getByTestId('obs-credits-rollup');
    expect(row).toHaveAttribute('data-map-credit');
    expect(within(row).getByRole('link', { name: 'Rain radar data by RainViewer' })).toHaveAttribute(
        'href',
        'https://www.rainviewer.com/',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Credits' }));
    const panel = screen.getByRole('dialog', { name: 'Map credits & source status' });
    expect(panel).toHaveTextContent(p.wind!);
    expect(panel).toHaveTextContent('E.U. Copernicus Marine Service Information');
    for (const doi of ['10.48670/moi-00016', '10.48670/moi-00017', '10.48670/moi-00015'])
        expect(within(panel).getByRole('link', { name: new RegExp(doi) })).toHaveAttribute(
            'href',
            `https://doi.org/${doi}`,
        );
    expect(panel).toHaveTextContent('NOAA/NESDIS GMGSI: GOES, Meteosat (EUMETSAT), Himawari (JMA)');
    expect(panel).toHaveTextContent('AISHub contributors');
    expect(panel).toHaveTextContent('delayed and incomplete');
    fireEvent.click(within(panel).getByRole('button', { name: 'Play satellite loop' }));
    expect(p.onToggleSatellite).toHaveBeenCalledTimes(1);
    fireEvent.click(within(panel).getByRole('link', { name: /Global Ocean Physics/ }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://doi.org/10.48670/moi-00016');
    fireEvent.click(within(panel).getByRole('button', { name: /^Close$/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
});
it('a closed rollup still reflects stale/unknown satellite, AIS and lightning status without claiming clear conditions', () => {
    const p = props();
    p.lightning = true;
    p.satellite.frameTimeMs = now - 5 * 3600000;
    publishAisCoverage({ state: 'held' });
    render(<ObsCreditsRollup {...p} />);
    const button = screen.getByRole('button', { name: 'Credits; layer status needs review' });
    expect(button).toHaveTextContent('!');
    fireEvent.click(button);
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveTextContent('5 h old');
    expect(panel).toHaveTextContent('licence review');
    expect(panel).toHaveTextContent('Lightning feed closed');
    expect(panel).toHaveTextContent('Blitzortung.org');
    expect(panel).toHaveTextContent('CC BY-SA 4.0');
});
it('rain forecast credits remain distinct, and all-off retires the open panel', () => {
    const p = props();
    p.rain = 'forecast';
    const view = render(<ObsCreditsRollup {...p} />);
    const link = screen.getByRole('link', { name: 'Rain forecast imagery by Rainbow.ai' });
    fireEvent.click(link);
    expect(openExternalUrl).toHaveBeenCalledWith('https://rainbow.ai/');
    fireEvent.click(screen.getByRole('button', { name: 'Credits' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('not observed radar');
    view.rerender(
        <ObsCreditsRollup
            {...p}
            rain={null}
            wind={null}
            cmems={[]}
            lightning={false}
            ais={false}
            satellite={{ ...p.satellite, status: 'off' }}
        />,
    );
    expect(screen.queryByTestId('obs-credits-rollup')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
});
it('optional coarse receiver status stays inside the existing rollup and never replaces internet AIS credit', () => {
    render(
        <ObsCreditsRollup {...props()} receiverCoverage={{ state: 'held', partial: false, cells: 0, asOf: null }} />,
    );
    expect(screen.getAllByTestId('obs-credits-rollup')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^Credits/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Internet AIS');
    expect(dialog).toHaveTextContent('Who’s listening');
    expect(dialog).toHaveTextContent('No public receiver identities or trails');
    expect(dialog).toHaveTextContent('prerequisites');
});
