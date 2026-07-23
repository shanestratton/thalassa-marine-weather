import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    checkPiHasGdal: vi.fn(),
    installEncFromUrl: vi.fn(),
    listPiInstalledCharts: vi.fn(),
    getCoverage: vi.fn(),
}));

vi.mock('../services/EncImportService', () => ({
    pickEncFile: vi.fn(),
    isLikelyEncFile: vi.fn(),
    checkPiHasGdal: mocks.checkPiHasGdal,
    importEncCell: vi.fn(),
    installEncFromUrl: mocks.installEncFromUrl,
    syncEncFromPi: vi.fn(),
    listPiInstalledCharts: mocks.listPiInstalledCharts,
}));

vi.mock('../services/enc/EncHazardService', () => ({
    getCoverage: mocks.getCoverage,
    removeCell: vi.fn(),
}));

vi.mock('../stores/MapFitTargetStore', () => ({ requestMapFit: vi.fn() }));
vi.mock('../context/UIContext', () => ({ useUI: () => ({ setPage: vi.fn() }) }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { EncCellManager } from '../components/vessel/EncCellManager';

async function openUrlDialog(): Promise<HTMLInputElement> {
    if (!screen.queryByRole('button', { name: /Install on Pi from URL/i })) {
        fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /Install on Pi from URL/i }));
    expect(screen.getByRole('dialog', { name: 'Install ENC from URL' })).toBeInTheDocument();
    return screen.getByRole('textbox', { name: 'Chart URL' }) as HTMLInputElement;
}

describe('EncCellManager URL dialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCoverage.mockReturnValue([]);
        mocks.listPiInstalledCharts.mockResolvedValue([]);
        mocks.checkPiHasGdal.mockResolvedValue(null);
        mocks.installEncFromUrl.mockResolvedValue({ cells: [], skipped: [] });
    });

    it('supports cancel, validates schemes, and submits only once', async () => {
        render(<EncCellManager />);
        await openUrlDialog();

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog', { name: 'Install ENC from URL' })).not.toBeInTheDocument();
        expect(mocks.installEncFromUrl).not.toHaveBeenCalled();

        const input = await openUrlDialog();
        fireEvent.change(input, { target: { value: 'ftp://charts.example/cell.zip' } });
        fireEvent.click(screen.getByRole('button', { name: 'Install on Pi' }));
        expect(screen.getByRole('alert')).toHaveTextContent('Only http/https URLs are supported.');
        expect(mocks.installEncFromUrl).not.toHaveBeenCalled();

        let finishInstall!: (value: { cells: []; skipped: [] }) => void;
        mocks.installEncFromUrl.mockReturnValue(
            new Promise((resolve) => {
                finishInstall = resolve;
            }),
        );
        fireEvent.change(input, { target: { value: 'https://charts.example/cell.zip' } });
        const install = screen.getByRole('button', { name: 'Install on Pi' });
        fireEvent.click(install);
        fireEvent.click(install);

        await waitFor(() => expect(mocks.checkPiHasGdal).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(mocks.installEncFromUrl).toHaveBeenCalledWith(
                'https://charts.example/cell.zip',
                undefined,
                expect.any(Function),
            ),
        );
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(1);

        await act(async () => {
            finishInstall({ cells: [], skipped: [] });
        });
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Install ENC from URL' })).not.toBeInTheDocument(),
        );
    });

    it('keeps the app dialog open and announces Pi/import failures', async () => {
        mocks.checkPiHasGdal.mockResolvedValue('Pi chart converter is unavailable');
        render(<EncCellManager />);
        const input = await openUrlDialog();

        fireEvent.change(input, { target: { value: 'https://charts.example/cell.zip' } });
        fireEvent.click(screen.getByRole('button', { name: 'Install on Pi' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Pi chart converter is unavailable');
        expect(screen.getByRole('dialog', { name: 'Install ENC from URL' })).toBeInTheDocument();
        expect(mocks.installEncFromUrl).not.toHaveBeenCalled();
    });
});
