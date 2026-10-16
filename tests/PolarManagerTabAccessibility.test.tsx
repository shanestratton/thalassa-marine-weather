import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/settings/PolarChart', () => ({
    PolarChart: () => <div data-testid="polar-chart" />,
}));

vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        onStatusChange: vi.fn(() => () => undefined),
        getStatus: vi.fn(() => 'disconnected'),
        getHasRpmData: vi.fn(() => false),
        configure: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

const learner = vi.hoisted(() => ({
    feed: 'none' as 'pi' | 'gateway' | 'cloud' | 'quiet' | 'none',
    statusListener: null as null | ((s: unknown) => void),
}));
vi.mock('../services/SmartPolarService', () => ({
    SmartPolarService: {
        onStatusChange: vi.fn((cb: (s: unknown) => void) => {
            learner.statusListener = cb;
            return () => undefined;
        }),
        start: vi.fn(),
        stop: vi.fn(),
    },
}));
vi.mock('../services/smartPolarFeed', () => ({
    learnerFeedState: () => learner.feed,
    subscribeLearnerFeedState: () => () => undefined,
}));

vi.mock('../services/SmartPolarStore', () => ({
    SmartPolarStore: {
        initialize: vi.fn().mockResolvedValue(undefined),
        ensureLoaded: vi.fn().mockResolvedValue(undefined),
        exportToPolarData: vi.fn(() => null),
        getStats: vi.fn(() => ({ totalSamples: 0, filledBuckets: 0, totalBuckets: 1 })),
        reset: vi.fn().mockResolvedValue(undefined),
    },
}));

import { PolarManagerTab } from '../components/settings/PolarManagerTab';

const settings = {
    polarData: {
        windSpeeds: [6],
        angles: [45],
        matrix: [[4.2]],
    },
    polarBoatModel: 'Test yacht',
    polarSource_type: 'manual' as const,
};

describe('PolarManagerTab advanced input accessibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        learner.feed = 'none';
        learner.statusListener = null;
    });

    it('opens a labelled modal, focuses its close action, and restores focus after Escape', async () => {
        render(<PolarManagerTab settings={settings} />);
        await act(async () => {
            await Promise.resolve();
        });

        const opener = screen.getByRole('button', { name: 'Enter polar figures' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Enter polar figures' });
        const closeButton = screen.getByRole('button', { name: 'Close polar figures' });
        const overlay = dialog.closest<HTMLElement>('[data-overlay-layer="modal"]');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay?.style.zIndex).toBe('1100');
        expect(document.activeElement).toBe(closeButton);

        fireEvent.keyDown(closeButton, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Enter polar figures' })).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('gives each input method and manual matrix cell a distinct accessible name', async () => {
        render(<PolarManagerTab settings={settings} />);
        await act(async () => {
            await Promise.resolve();
        });
        fireEvent.click(screen.getByRole('button', { name: 'Enter polar figures' }));

        const importButton = screen.getByRole('button', { name: 'Import' });
        const manualButton = screen.getByRole('button', { name: 'Manual' });
        expect(importButton.getAttribute('aria-pressed')).toBe('true');
        expect(manualButton.getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByRole('button', { name: /Drop polar file here/ })).toBeDefined();

        fireEvent.click(manualButton);
        expect(manualButton.getAttribute('aria-pressed')).toBe('true');
        expect(
            screen.getByRole('spinbutton', {
                name: 'Boat speed at 45 degrees true wind angle and 6 knots true wind speed',
            }),
        ).toBeDefined();
    });
});

describe('134-06 owner polar controls', () => {
    it('persists the explicit sailing adjustment without rewriting the saved polar', async () => {
        const save = vi.fn();
        render(<PolarManagerTab settings={settings} onSave={save} />);
        await act(async () => {
            await Promise.resolve();
        });
        fireEvent.change(screen.getByRole('slider', { name: 'Routing polar performance' }), {
            target: { value: '85' },
        });
        expect(save).toHaveBeenLastCalledWith({ routingPolarScale: 0.85 });
        expect(screen.getByText('Routing polar: 85%')).toBeDefined();
    });
    it('builds a target estimate only after confirming replacement and keeps it manual', async () => {
        const save = vi.fn();
        render(<PolarManagerTab settings={settings} onSave={save} />);
        await act(async () => {
            await Promise.resolve();
        });
        fireEvent.click(screen.getByRole('button', { name: 'Enter polar figures' }));
        fireEvent.click(screen.getByRole('button', { name: 'Targets' }));
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Beat angle (°)' }), { target: { value: '40' } });
        fireEvent.click(screen.getByRole('button', { name: 'Use estimated polar' }));
        expect(save).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Replace your polar?' })).toBeDefined();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Replace polar' }));
        });
        expect(save).toHaveBeenCalledWith(
            expect.objectContaining({
                polarSource_type: 'manual',
                polarBoatModel: 'Target-speed estimate',
                polarData: expect.objectContaining({ angles: expect.arrayContaining([40, 90, 180]) }),
            }),
        );
    });
    it('adds a grid axis, preserves it on leaving, and requires confirmation before removing figures', async () => {
        const save = vi.fn();
        const table = {
            ...settings,
            polarData: {
                windSpeeds: [6, 12, 20],
                angles: [45, 90, 180],
                matrix: [
                    [3, 5, 6],
                    [4, 7, 8],
                    [2, 4, 5],
                ],
            },
        };
        const page = render(<PolarManagerTab settings={table} onSave={save} />);
        await act(async () => {
            await Promise.resolve();
        });
        fireEvent.click(screen.getByRole('button', { name: 'Enter polar figures' }));
        fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
        fireEvent.change(screen.getByRole('spinbutton', { name: 'New polar angle' }), { target: { value: '30' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add angle' }));
        expect(
            screen.getByRole('spinbutton', {
                name: 'Boat speed at 30 degrees true wind angle and 6 knots true wind speed',
            }),
        ).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: 'Remove 12 knot wind column' }));
        expect(screen.getByRole('dialog', { name: 'Remove these polar figures?' })).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: 'Keep figures' }));
        page.unmount();
        expect(save).toHaveBeenCalledWith(
            expect.objectContaining({
                polarData: expect.objectContaining({ windSpeeds: [6, 12, 20], angles: [30, 45, 90, 180] }),
            }),
        );
    });
});

/**
 * Build 126, package 126-B6a (polars-01): the Smart Polars card says where the
 * learner hears the boat from — the Pi, the gateway, the cloud only, or
 * nothing — instead of this phone's gateway socket, which never opens on a Pi
 * boat and read "NMEA: Disconnected" on Serene Summer while the Pi fed every
 * instrument. Fictional boat; the feed state is the learner's own
 * (services/smartPolarFeed).
 */
describe('PolarManagerTab Smart Polars card: where the instruments come from', () => {
    const on = { ...settings, smartPolarsEnabled: true };
    const off = { ...settings, smartPolarsEnabled: false };
    const gates = (engineOff: 'pass' | 'fail' | 'unavailable') => ({
        engineOff,
        stableHeading: 'pass',
        steadyWind: 'pass',
        minimumSpeed: 'pass',
        steadyState: 'unavailable',
        recording: false,
        totalAccepted: 0,
        totalRejected: 0,
    });

    beforeEach(() => {
        vi.clearAllMocks();
        learner.feed = 'none';
        learner.statusListener = null;
    });

    it('on a Pi boat: "Instruments: via the Pi", and none of the socket\'s words', async () => {
        learner.feed = 'pi';
        for (const page of [on, off]) {
            const { container } = render(<PolarManagerTab settings={page} />);
            await act(async () => {
                await Promise.resolve();
            });
            expect(screen.getByText('Instruments: via the Pi')).toBeDefined();
            const text = container.textContent ?? '';
            expect(text).not.toContain('NMEA 2000 backbone');
            expect(text).not.toContain('Not connected');
            expect(text).not.toContain('NMEA: Disconnected');
            cleanup();
        }
    });

    it('says where the learner hears the boat from, in each of its five states', async () => {
        const words = {
            pi: 'Instruments: via the Pi',
            gateway: 'Instruments: via the NMEA gateway',
            cloud: 'Seen through the cloud only: learning needs a direct link to the Pi or the gateway',
            quiet: 'The Pi is on; her instruments are quiet',
            none: 'Not reaching the boat',
        } as const;
        for (const [feed, said] of Object.entries(words) as Array<[keyof typeof words, string]>) {
            learner.feed = feed;
            render(<PolarManagerTab settings={on} />);
            await act(async () => {
                await Promise.resolve();
            });
            expect(screen.getByText(said)).toBeDefined();
            cleanup();
        }
    });

    it('explains itself in terms of the boat, not the backbone', async () => {
        learner.feed = 'none';
        const { container } = render(<PolarManagerTab settings={off} onNavigateToNmea={vi.fn()} />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(container.textContent).toContain(
            "Smart Polars learns your boat's real speeds from her instruments (the Pi or an NMEA gateway).",
        );
        expect(screen.getByText('Not reaching the boat')).toBeDefined();
    });

    it('offers "Set up instruments" only when nothing reaches the boat — not to a quiet Pi or the cloud', async () => {
        for (const [feed, link] of [
            ['none', true],
            ['quiet', false],
            ['cloud', false],
        ] as const) {
            learner.feed = feed;
            render(<PolarManagerTab settings={off} onNavigateToNmea={vi.fn()} />);
            await act(async () => {
                await Promise.resolve();
            });
            expect(screen.queryByRole('button', { name: /Set up instruments/ }) !== null).toBe(link);
            cleanup();
        }
    });

    it('"No engine data" only when neither RPM nor alternator voltage reaches the learner', async () => {
        learner.feed = 'pi';
        render(<PolarManagerTab settings={on} />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByText(/No RPM data/)).toBeNull();
        expect(screen.queryByText(/No engine data/)).toBeNull();
        act(() => learner.statusListener?.(gates('unavailable')));
        expect(screen.getByText('No engine data: the engine-off check is skipped')).toBeDefined();
        act(() => learner.statusListener?.(gates('pass')));
        expect(screen.queryByText(/No engine data/)).toBeNull();
    });
});
