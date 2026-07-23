import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('../services/SmartPolarService', () => ({
    SmartPolarService: {
        onStatusChange: vi.fn(() => () => undefined),
        start: vi.fn(),
        stop: vi.fn(),
    },
}));

vi.mock('../services/SmartPolarStore', () => ({
    SmartPolarStore: {
        initialize: vi.fn().mockResolvedValue(undefined),
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
    });

    it('opens a labelled modal, focuses its close action, and restores focus after Escape', async () => {
        render(<PolarManagerTab settings={settings} />);
        await act(async () => {
            await Promise.resolve();
        });

        const opener = screen.getByRole('button', { name: 'Advanced polar input' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Advanced Polar Input' });
        const closeButton = screen.getByRole('button', { name: 'Close advanced polar input' });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(document.activeElement).toBe(closeButton);

        fireEvent.keyDown(closeButton, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Advanced Polar Input' })).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('gives each input method and manual matrix cell a distinct accessible name', async () => {
        render(<PolarManagerTab settings={settings} />);
        await act(async () => {
            await Promise.resolve();
        });
        fireEvent.click(screen.getByRole('button', { name: 'Advanced polar input' }));

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
