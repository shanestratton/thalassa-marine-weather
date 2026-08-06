import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getCoverage: vi.fn(),
    removeCell: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    pickFile: vi.fn(),
    importFile: vi.fn(),
    importUrl: vi.fn(),
    validateUrl: vi.fn((value: string) => {
        if (!value.startsWith('https://')) throw new Error('ENC pack URLs must use HTTPS.');
        return new URL(value);
    }),
    requestMapFit: vi.fn(),
    triggerHaptic: vi.fn(),
}));

vi.mock('../services/enc/EncHazardService', () => ({
    getDisplayCoverage: mocks.getCoverage,
    removeCell: mocks.removeCell,
    subscribe: mocks.subscribe,
}));

vi.mock('../services/enc/localEncPackImport', () => ({
    pickLocalEncPackFile: mocks.pickFile,
    importLocalEncPackFile: mocks.importFile,
    importLocalEncPackUrl: mocks.importUrl,
    validateLocalEncPackUrl: mocks.validateUrl,
}));

vi.mock('../stores/MapFitTargetStore', () => ({ requestMapFit: mocks.requestMapFit }));
vi.mock('../utils/system', () => ({ triggerHaptic: mocks.triggerHaptic }));

import { EncLibraryPage } from '../components/vessel/EncLibraryPage';

const importedCell = {
    id: 'VU5PORT1',
    sourceHO: 'VU',
    edition: 4,
    issued: '2026-07-01',
    importedAt: '2026-08-05T00:00:00.000Z',
    bbox: [167, -17, 169, -15] as [number, number, number, number],
    geojsonPath: 'enc-cells/VU5PORT1.geojson',
    hazardCount: 123,
    catzocRange: null,
    usage: 'reference' as const,
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCoverage.mockReturnValue([]);
    mocks.pickFile.mockResolvedValue(new File(['{}'], 'Vanuatu.thalassaenc'));
    mocks.importFile.mockResolvedValue({ cells: [importedCell], skipped: [] });
    mocks.importUrl.mockResolvedValue({ cells: [importedCell], skipped: [] });
    mocks.removeCell.mockResolvedValue(undefined);
});

describe('EncLibraryPage', () => {
    it('honestly exposes local/HTTPS converted-pack import without raw or Pi controls', () => {
        render(<EncLibraryPage onBack={vi.fn()} onOpenMap={vi.fn()} />);

        expect(screen.getByRole('heading', { name: 'No reference ENC cells are installed' })).toBeInTheDocument();
        expect(
            screen.getByText(/Bathymetry estimates and satellite imagery are not ENC coverage/i),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Import from Files' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Import from HTTPS URL' })).toBeEnabled();
        expect(screen.getByText(/cannot decode S-57/i)).toHaveTextContent(/S-63.*o-charts/i);
        // The ENC Library must stay independent of the Pi. Since 2026-08-06
        // that is a separation statement rather than a beta hold — the Pi
        // ships, but nothing on this page reaches it.
        expect(screen.getByText(/Pi discovery and sync stay separate/i)).toHaveTextContent(
            /pinned boat-network transport/i,
        );
        expect(screen.getByText(/cannot authenticate the publisher/i)).toHaveTextContent(
            /ignored by route verification/i,
        );
        expect(screen.queryByRole('button', { name: /Pi|sync/i })).not.toBeInTheDocument();
    });

    it('imports a selected converted pack and announces completion', async () => {
        const { rerender } = render(<EncLibraryPage onBack={vi.fn()} onOpenMap={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Import from Files' }));

        await waitFor(() => expect(mocks.importFile).toHaveBeenCalledOnce());
        expect(await screen.findByText('1 unverified reference ENC cell imported to this device.')).toBeInTheDocument();

        mocks.getCoverage.mockReturnValue([importedCell]);
        rerender(<EncLibraryPage onBack={vi.fn()} onOpenMap={vi.fn()} />);
    });

    it('keeps the URL dialog open, requires HTTPS, and deduplicates submission while busy', async () => {
        let finish!: (value: { cells: (typeof importedCell)[]; skipped: [] }) => void;
        mocks.importUrl.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        render(<EncLibraryPage onBack={vi.fn()} onOpenMap={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Import from HTTPS URL' }));
        const input = screen.getByRole('textbox', { name: 'Direct HTTPS URL' });
        fireEvent.change(input, { target: { value: 'http://charts.example/pack.json' } });
        fireEvent.click(screen.getByRole('button', { name: 'Import to device' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('must use HTTPS');
        expect(mocks.importUrl).not.toHaveBeenCalled();

        fireEvent.change(input, { target: { value: 'https://charts.example/pack.json' } });
        const submit = screen.getByRole('button', { name: 'Import to device' });
        fireEvent.click(submit);
        fireEvent.click(submit);
        await waitFor(() => expect(mocks.importUrl).toHaveBeenCalledTimes(1));

        await act(async () => finish({ cells: [importedCell], skipped: [] }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Import ENC pack from URL' })).not.toBeInTheDocument(),
        );
    });

    it('shows installed coverage on the map and requires confirmation before removal', async () => {
        mocks.getCoverage.mockReturnValue([importedCell]);
        const onOpenMap = vi.fn();
        render(<EncLibraryPage onBack={vi.fn()} onOpenMap={onOpenMap} />);

        fireEvent.click(screen.getByRole('button', { name: 'Show VU5PORT1 reference coverage on the chart' }));
        expect(mocks.requestMapFit).toHaveBeenCalledWith(expect.objectContaining({ bbox: importedCell.bbox }));
        expect(onOpenMap).toHaveBeenCalledOnce();

        fireEvent.click(screen.getByRole('button', { name: 'Remove VU5PORT1 from this device' }));
        expect(mocks.removeCell).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of VU5PORT1' }));
        await waitFor(() => expect(mocks.removeCell).toHaveBeenCalledWith('VU5PORT1'));
    });
});
