/**
 * RainViewer give us the radar for free and their terms ask that the source be
 * named "with a link". So the credit stays. What does NOT have to stay is a
 * full-width anchor that navigates the WebView away from the app: brushing it
 * while scrubbing dumped the skipper out of the chart (Shane 2026-08-22, "i
 * have accidently pressed it twice"). On a navigation app, losing the chart to
 * a stray tap is a genuinely bad outcome rather than an annoyance.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MapWeatherControls } from '../components/map/MapWeatherControls';
import type { useWeatherLayers } from '../components/map/useWeatherLayers';

const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock('../services/externalLinks', () => ({ openExternalUrl }));

type W = ReturnType<typeof useWeatherLayers>;

function weather(): W {
    return {
        activeLayers: new Set(['rain']),
        rainReady: true,
        rainLoading: false,
        rainImageLoading: false,
        rainFrameCount: 3,
        rainFrameIndex: 1,
        rainPlaying: false,
        rainNowIdxRef: { current: 1 },
        unifiedFramesRef: {
            current: [
                { label: '-10m', type: 'radar' },
                { label: 'Now', type: 'radar' },
                { label: '+20m', type: 'forecast' },
            ],
        },
        setRainFrameIndex: vi.fn(),
        setRainPlaying: vi.fn(),
        retryRain: vi.fn(),
    } as unknown as W;
}

afterEach(() => {
    cleanup();
    openExternalUrl.mockClear();
});

describe('RainViewer attribution', () => {
    it('still credits RainViewer by name', () => {
        render(
            <MapWeatherControls
                weather={weather()}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );
        expect(screen.getByText(/radar by rainviewer/i)).toBeTruthy();
    });

    it('opens a dismissible sheet instead of navigating the app away', () => {
        render(
            <MapWeatherControls
                weather={weather()}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('link', { name: /rainviewer/i }));
        // openExternalUrl presents a sheet over the app; the chart survives and
        // Done returns to it. A bare <a target="_blank"> did not.
        expect(openExternalUrl).toHaveBeenCalledWith('https://www.rainviewer.com/');
    });

    it('keeps a real href — their terms ask for a LINK, not just a mention', () => {
        render(
            <MapWeatherControls
                weather={weather()}
                visible
                embedded={false}
                controlsHidden={false}
                onControlsHiddenChange={vi.fn()}
            />,
        );
        // A button would have satisfied the UX fix while quietly downgrading
        // the credit. It stays an anchor: copyable, long-pressable, a link.
        expect(screen.getByRole('link', { name: /rainviewer/i })).toHaveAttribute(
            'href',
            'https://www.rainviewer.com/',
        );
    });

    it('leaves the credit LABEL inert — only the small ⓘ is a tap target', () => {
        const src = readFileSync('components/map/MapWeatherControls.tsx', 'utf8');
        const block = src.slice(src.indexOf('{showRainViewerAttribution && ('), src.indexOf('{controlsHidden ? ('));
        // The words themselves must not be clickable, or the accident just
        // recurs against a wider target.
        expect(block).toContain('<span className="text-[10px] font-semibold text-slate-300/80">Radar by RainViewer</span>');
        // target="_blank" is what navigated the WebView away in the first place.
        expect(block).not.toContain('target="_blank"');
        expect(block).toContain('e.preventDefault()');
    });
});
