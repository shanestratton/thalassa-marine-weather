import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncImportProgress, EncImportSummary } from '../services/EncImportService';

const mocks = vi.hoisted(() => ({
    checkPiHasGdal: vi.fn(),
    installEncFromUrl: vi.fn(),
    listPiInstalledCharts: vi.fn(),
    listRecentEncInstalls: vi.fn(),
    resumeEncInstall: vi.fn(),
    getCoverage: vi.fn(),
    currentScope: vi.fn(),
    baseUrl: 'http://paired-pi.test',
    pairingKey: 'key-one',
}));
vi.mock('../services/EncImportService', () => ({
    pickEncFile: vi.fn(),
    isLikelyEncFile: vi.fn(),
    checkPiHasGdal: mocks.checkPiHasGdal,
    importEncCell: vi.fn(),
    installEncFromUrl: mocks.installEncFromUrl,
    syncEncFromPi: vi.fn(),
    listPiInstalledCharts: mocks.listPiInstalledCharts,
    listRecentEncInstalls: mocks.listRecentEncInstalls,
    resumeEncInstall: mocks.resumeEncInstall,
    encCellSyncKey: (id: string, edition: number, sizeBytes?: number, contentSha256?: string) =>
        `${id}@${edition}@${sizeBytes}@${contentSha256}`,
}));
vi.mock('../services/enc/EncHazardService', () => ({ getCoverage: mocks.getCoverage, removeCell: vi.fn() }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => true,
        onStatusChange: () => () => {},
        get baseUrl() {
            return mocks.baseUrl;
        },
    },
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ userId: 'owner', generation: 1 }),
    isAuthIdentityScopeCurrent: mocks.currentScope,
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => ({ publicKeySpki: mocks.pairingKey }) }));
vi.mock('../stores/MapFitTargetStore', () => ({ requestMapFit: vi.fn() }));
vi.mock('../context/UIContext', () => ({ useUI: () => ({ setPage: vi.fn() }) }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
import { EncCellManager } from '../components/vessel/EncCellManager';

const first = 'https://charts.example/private-token-one/download';
const second = 'https://charts.example/private-token-two/download';
const empty: EncImportSummary = { cells: [], skipped: [], installedOnPi: true };
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function openDialog(): Promise<HTMLTextAreaElement> {
    if (!screen.queryByRole('button', { name: 'Add or update charts' }))
        fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add or update charts' }));
    expect(screen.getByRole('dialog', { name: 'Add or update charts' })).toBeInTheDocument();
    return screen.getByRole('textbox', { name: 'Delivery emails or download links' }) as HTMLTextAreaElement;
}
function submit(value: string) {
    fireEvent.change(screen.getByRole('textbox', { name: 'Delivery emails or download links' }), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Add or update on Pi' }));
}
const results = () => screen.getByRole('region', { name: 'Chart package results' });

describe('easy chart delivery dialog', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.baseUrl = 'http://paired-pi.test';
        mocks.pairingKey = 'key-one';
        mocks.currentScope.mockReturnValue(true);
        mocks.getCoverage.mockReturnValue([]);
        mocks.listPiInstalledCharts.mockResolvedValue([]);
        mocks.listRecentEncInstalls.mockResolvedValue([]);
        mocks.resumeEncInstall.mockResolvedValue(empty);
        mocks.checkPiHasGdal.mockResolvedValue('GDAL not installed');
        mocks.installEncFromUrl.mockResolvedValue(empty);
    });

    it('cancels without installing, then rejects invalid links', async () => {
        render(<EncCellManager />);
        await openDialog();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(mocks.installEncFromUrl).not.toHaveBeenCalled();
        await openDialog();
        submit('ftp://charts.example/private.zip');
        expect(screen.getByRole('alert')).toHaveTextContent('Only HTTP or HTTPS');
        expect(mocks.installEncFromUrl).not.toHaveBeenCalled();
    });

    it('accepts two full emails, installs sequentially once, and preserves results without a GDAL precheck', async () => {
        const one = deferred<EncImportSummary>(),
            two = deferred<EncImportSummary>();
        mocks.installEncFromUrl.mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
        render(<EncCellManager />);
        await openDialog();
        submit(
            `Hi Test Skipper,\n\nChart successfully processed\n\nDownload link\n\n${first}\n\nOrder reference: TEST-ORDER\nChart: Coast pack\nSystem: TEST-SYSTEM\nFile size: 100 MB\n\nHi Test Skipper,\n\nChart successfully processed\n\nDownload link\n\n${second}\n\nOrder reference: TEST-UPDATE\nChart: Island update\nSystem: TEST-SYSTEM\nFile size: 200 MB`,
        );
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(1);
        expect(mocks.installEncFromUrl).toHaveBeenNthCalledWith(1, first, undefined, expect.any(Function), undefined);
        expect(mocks.checkPiHasGdal).not.toHaveBeenCalled();
        expect(within(results()).getByText('Coast pack')).toBeInTheDocument();
        fireEvent.submit(screen.getByRole('textbox').closest('form')!);
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(1);
        await act(async () =>
            one.resolve({ ...empty, packageSummary: { new: 2, updated: 1, unchanged: 3, total: 6 } }),
        );
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(2);
        expect(mocks.installEncFromUrl).toHaveBeenNthCalledWith(2, second, undefined, expect.any(Function), undefined);
        expect(results()).toHaveTextContent('2 new, 1 updated, 3 unchanged');
        await act(async () => two.resolve(empty));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(results()).toHaveTextContent('Island update');
        expect(results()).not.toHaveTextContent('private-token');
        fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1)!);
        await openDialog();
        expect(results()).toHaveTextContent('Coast pack');
        expect(results()).toHaveTextContent('Island update');
        submit(first);
        expect(screen.getByRole('alert')).toHaveTextContent('already listed');
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(2);
    });

    it('passes an optional publisher checksum and refuses an ambiguous association before any installation', async () => {
        render(<EncCellManager />);
        await openDialog();
        submit(`${first}\n${second}\nSHA256: ${'a'.repeat(64)}`);
        expect(screen.getByRole('alert')).toHaveTextContent('cannot be matched safely');
        expect(mocks.installEncFromUrl).not.toHaveBeenCalled();
        submit(
            `Hi Test Skipper,\n\nDownload link\n\n${first}\n\nOrder reference: TEST-ORDER\nChart: Coast pack\nSystem: TEST-SYSTEM\nFile size: 100 MB\nSHA256: ${'a'.repeat(64)}`,
        );
        await waitFor(() =>
            expect(mocks.installEncFromUrl).toHaveBeenCalledWith(first, undefined, expect.any(Function), {
                expectedSha256: 'a'.repeat(64),
            }),
        );
        expect(results()).toHaveTextContent('Publisher checksum included');
        expect(results()).toHaveTextContent('Coast pack');
    });

    it('continues after a failure and retry processes only failed packages', async () => {
        mocks.installEncFromUrl
            .mockRejectedValueOnce(new Error(`download failed ${first}?secret=private`))
            .mockResolvedValue(empty);
        render(<EncCellManager />);
        await openDialog();
        submit(`${first}\n${second}`);
        const retry = await screen.findByRole('button', { name: 'Retry failed packages' });
        await waitFor(() => expect(retry).not.toBeDisabled());
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(2);
        expect(results()).not.toHaveTextContent('private-token');
        expect(results()).not.toHaveTextContent('secret=');
        fireEvent.click(retry);
        await waitFor(() => expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(3));
        expect(mocks.installEncFromUrl.mock.calls.map((call) => call[0])).toEqual([first, second, first]);
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Retry failed packages' })).not.toBeInTheDocument(),
        );
        expect(within(results()).getAllByText(/Installed on Pi/)).toHaveLength(2);
    });

    it('shows installed-on-Pi but incomplete phone copies without claiming readiness or offering reinstall', async () => {
        mocks.installEncFromUrl.mockResolvedValue({
            ...empty,
            skipped: [{ filename: 'PRIVATE', error: `${first}?secret=private` }],
        });
        render(<EncCellManager />);
        await openDialog();
        submit(first);
        await waitFor(() => expect(results()).toHaveTextContent('Installed on Pi. Phone copy is incomplete.'));
        expect(results()).toHaveTextContent('connection or storage issues can be retried');
        expect(results()).toHaveTextContent('Do not reinstall the Pi package');
        expect(results()).not.toHaveTextContent('phone sync pending');
        expect(results()).not.toHaveTextContent('available on this phone');
        expect(results()).not.toHaveTextContent('PRIVATE');
        expect(screen.queryByRole('button', { name: 'Retry failed packages' })).not.toBeInTheDocument();
        submit(first);
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(1);
    });

    it.each(['accepted-job', ''])(
        'does not retry an unconfirmed Pi job (%s) or automatically start the next package',
        async (jobId) => {
            mocks.installEncFromUrl
                .mockRejectedValueOnce(
                    Object.assign(new Error(first), {
                        name: 'EncInstallPendingError',
                        jobId,
                        installationPending: true,
                    }),
                )
                .mockResolvedValue(empty);
            render(<EncCellManager />);
            await openDialog();
            submit(`${first}\n${second}`);
            await waitFor(() => expect(results()).toHaveTextContent('may still be installing'));
            expect(results()).toHaveTextContent('Not started');
            expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(1);
            expect(results()).not.toHaveTextContent('private-token');
            fireEvent.click(screen.getByRole('button', { name: 'Retry failed packages' }));
            await waitFor(() => expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(2));
            expect(mocks.installEncFromUrl.mock.calls.map((call) => call[0])).toEqual([first, second]);
            await waitFor(() =>
                expect(screen.queryByRole('button', { name: 'Retry failed packages' })).not.toBeInTheDocument(),
            );
            submit(first);
            expect(screen.getByRole('alert')).toHaveTextContent('already listed');
            expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(2);
        },
    );

    it('reconciles a pending delivery after resuming the same durable receipt', async () => {
        mocks.installEncFromUrl.mockRejectedValueOnce(
            Object.assign(new Error(first), { name: 'EncInstallPendingError', jobId: 'accepted-job' }),
        );
        mocks.listRecentEncInstalls.mockResolvedValue([{ id: 'accepted-job', status: 'converting', startedAt: 1000 }]);
        render(<EncCellManager />);
        await openDialog();
        submit(first);
        await waitFor(() => expect(results()).toHaveTextContent('may still be installing'));
        fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1)!);
        fireEvent.click(await screen.findByRole('button', { name: 'Continue install' }));
        await waitFor(() =>
            expect(screen.getByRole('region', { name: 'Recent chart installs' })).toHaveTextContent(
                'No new charts were copied',
            ),
        );
        await openDialog();
        expect(results()).toHaveTextContent('Installed on Pi');
        expect(results()).not.toHaveTextContent('may still be installing');
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(1);
    });

    it('shows safe progress without reflecting provider URLs, tokens or error text', async () => {
        const pending = deferred<EncImportSummary>();
        mocks.installEncFromUrl.mockImplementation(
            (_url: string, _filename: string | undefined, progress: (p: EncImportProgress) => void) => {
                progress({ phase: 'uploading', progress: 0.25, step: first, error: 'private-token' });
                return pending.promise;
            },
        );
        render(<EncCellManager />);
        await openDialog();
        submit(first);
        expect(results()).toHaveTextContent('25%');
        expect(results()).not.toHaveTextContent('private-token');
        await act(async () => pending.resolve(empty));
    });

    it('stops the queue after unmount without starting the next package', async () => {
        const pending = deferred<EncImportSummary>();
        mocks.installEncFromUrl.mockReturnValue(pending.promise);
        const view = render(<EncCellManager />);
        await openDialog();
        submit(`${first}\n${second}`);
        view.unmount();
        await act(async () => pending.resolve(empty));
        expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(1);
    });

    it.each(['account', 'address', 'pairing'] as const)(
        'stops remaining packages if the %s changes, preserving the already completed result',
        async (change) => {
            const pending = deferred<EncImportSummary>();
            mocks.installEncFromUrl.mockResolvedValueOnce(empty).mockReturnValueOnce(pending.promise);
            render(<EncCellManager />);
            await openDialog();
            submit(`${first}\n${second}\nhttps://charts.example/third/download`);
            await waitFor(() => expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(2));
            if (change === 'account') mocks.currentScope.mockReturnValue(false);
            if (change === 'address') mocks.baseUrl = 'http://different-pi.test';
            if (change === 'pairing') mocks.pairingKey = 'different-key';
            await act(async () => pending.resolve(empty));
            expect(mocks.installEncFromUrl).toHaveBeenCalledTimes(2);
            expect(results()).toHaveTextContent('Installed on Pi');
            expect(results()).toHaveTextContent('account or paired Pi changed');
        },
    );

    it('shows only three recent installs, never provider steps, errors or download secrets', async () => {
        mocks.listRecentEncInstalls.mockResolvedValue(
            Array.from({ length: 5 }, (_, index) => ({
                id: `receipt-${index}`,
                status: 'done',
                resultKind: 'installed',
                startedAt: 1000 + index,
                step: first,
                filename: first,
                error: first,
                packageSummary: { new: 1, updated: 2, unchanged: 3, total: 6 },
            })),
        );
        render(<EncCellManager />);
        expect(mocks.listRecentEncInstalls).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
        const recent = screen.getByRole('region', { name: 'Recent chart installs' });
        await waitFor(() => expect(within(recent).getAllByRole('button', { name: 'Sync charts' })).toHaveLength(3));
        expect(recent).toHaveTextContent('1 new, 2 updated, 3 unchanged');
        expect(recent).not.toHaveTextContent('private-token');
        expect(recent).not.toHaveTextContent('Recent install 4');
        await act(async () => fireEvent.click(within(recent).getAllByRole('button', { name: 'Sync charts' })[0]));
        expect(mocks.resumeEncInstall).toHaveBeenCalledWith('receipt-4', expect.any(Function));
    });

    it.each(['converting', 'done'])(
        'resumes a %s receipt without resubmitting a delivery or checking GDAL',
        async (status) => {
            mocks.listRecentEncInstalls.mockResolvedValue([
                { id: 'existing-job', status, resultKind: 'installed', startedAt: 1000 },
            ]);
            const pending = deferred<EncImportSummary>();
            mocks.resumeEncInstall.mockReturnValue(pending.promise);
            render(<EncCellManager />);
            fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
            const button = await screen.findByRole('button', {
                name: status === 'done' ? 'Sync charts' : 'Continue install',
            });
            fireEvent.click(button);
            fireEvent.click(button);
            expect(mocks.resumeEncInstall).toHaveBeenCalledExactlyOnceWith('existing-job', expect.any(Function));
            expect(mocks.installEncFromUrl).not.toHaveBeenCalled();
            expect(mocks.checkPiHasGdal).not.toHaveBeenCalled();
            await act(async () => pending.resolve({ ...empty, skipped: [{ filename: 'Phone copy', error: first }] }));
            expect(screen.getByRole('region', { name: 'Recent chart installs' })).toHaveTextContent(
                'Installed on Pi. Phone copy is incomplete.',
            );
        },
    );

    it.each([
        { total: 91, excluded: 3 },
        { total: 934, excluded: 2 },
    ])(
        'explains $excluded depth-area exclusions from a $total-chart installed receipt without promising pending copies',
        async ({ total, excluded }) => {
            mocks.listRecentEncInstalls.mockResolvedValue([
                { id: 'installed-job', status: 'done', resultKind: 'installed', startedAt: 1000 },
            ]);
            mocks.resumeEncInstall.mockResolvedValue({
                ...empty,
                cells: Array.from({ length: total - excluded }, () => ({})),
                skipped: Array.from({ length: excluded }, (_, index) => ({
                    filename: `SYNTH_${index + 1}`,
                    error: `SYNTH_${index + 1}: no DEPARE/DRGARE depth-area coverage; the pack cannot verify water depths.`,
                })),
            });
            render(<EncCellManager />);
            fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
            fireEvent.click(await screen.findByRole('button', { name: 'Sync charts' }));
            const recent = screen.getByRole('region', { name: 'Recent chart installs' });
            await waitFor(() => expect(recent).toHaveTextContent(`${excluded} charts excluded from phone use`));
            expect(recent).toHaveTextContent(`${total - excluded} charts copied to this phone`);
            expect(recent).toHaveTextContent('repeating the same sync will not add them');
            expect(recent).not.toHaveTextContent('pending');
            expect(recent).not.toHaveTextContent('Phone copy is incomplete');
            expect(screen.getAllByText(/Excluded from phone use: missing DEPARE\/DRGARE/)).toHaveLength(excluded);
            expect(screen.getByText('SYNTH_1')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Sync charts' })).not.toBeDisabled();
            expect(mocks.installEncFromUrl).not.toHaveBeenCalled();
        },
    );

    it('separates known exclusions from retryable and unknown failures, and clears old reasons on a later successful receipt sync', async () => {
        mocks.listRecentEncInstalls.mockResolvedValue([
            { id: 'mixed-job', status: 'done', resultKind: 'installed', startedAt: 1000 },
        ]);
        mocks.resumeEncInstall
            .mockResolvedValueOnce({
                ...empty,
                skipped: [
                    {
                        filename: 'SYNTH_1',
                        error: 'SYNTH_1: no DEPARE/DRGARE depth-area coverage; the pack cannot verify water depths.',
                    },
                    { filename: first, error: `Network timeout fetching ${first}` },
                    { filename: second, error: `Unexpected provider detail ${second}` },
                ],
            })
            .mockResolvedValue(empty);
        render(<EncCellManager />);
        fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
        fireEvent.click(await screen.findByRole('button', { name: 'Sync charts' }));
        const recent = screen.getByRole('region', { name: 'Recent chart installs' });
        await waitFor(() => expect(recent).toHaveTextContent('1 chart excluded from phone use'));
        expect(recent).toHaveTextContent('Phone copy is incomplete');
        expect(recent).not.toHaveTextContent('3 charts excluded');
        expect(screen.getByText(/The connection or download did not finish/)).toBeInTheDocument();
        expect(screen.getByText(/unclassified reason/)).toBeInTheDocument();
        expect(document.body).not.toHaveTextContent('private-token');
        fireEvent.click(screen.getByRole('button', { name: 'Sync charts' }));
        await waitFor(() => expect(recent).toHaveTextContent('No new charts were copied to this phone'));
        expect(screen.queryByText(/Excluded from phone use: missing/)).not.toBeInTheDocument();
        expect(screen.queryByText(/unclassified reason/)).not.toBeInTheDocument();
        expect(mocks.resumeEncInstall).toHaveBeenCalledTimes(2);
        expect(mocks.installEncFromUrl).not.toHaveBeenCalled();
    });

    it('allows a failed receipt to open the delivery form without exposing its error or starting work', async () => {
        mocks.listRecentEncInstalls.mockResolvedValue([
            { id: 'failed-job', status: 'error', error: first, step: first, startedAt: 1000 },
        ]);
        render(<EncCellManager />);
        fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
        fireEvent.click(await screen.findByRole('button', { name: 'Paste delivery again' }));
        expect(screen.getByRole('dialog', { name: 'Add or update charts' })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Recent chart installs', hidden: true })).not.toHaveTextContent(
            'private-token',
        );
        expect(mocks.installEncFromUrl).not.toHaveBeenCalled();
        expect(mocks.resumeEncInstall).not.toHaveBeenCalled();
    });

    it('surfaces unavailable recent receipts without guessing that there were no installs', async () => {
        mocks.listRecentEncInstalls.mockRejectedValue(new Error(first));
        render(<EncCellManager />);
        fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
        expect(await screen.findByText(/Recent installs are unavailable/)).toBeInTheDocument();
        expect(screen.queryByText('No recent installs reported by this Pi.')).not.toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Recent chart installs' })).not.toHaveTextContent('private-token');
    });

    it('does not render malformed receipt counts as arbitrary provider text', async () => {
        mocks.listRecentEncInstalls.mockResolvedValue([
            {
                id: 'receipt',
                status: 'done',
                resultKind: 'installed',
                startedAt: 1000,
                packageSummary: { new: first, updated: 0, unchanged: 0, total: 0 },
            },
        ]);
        render(<EncCellManager />);
        fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
        await screen.findByRole('button', { name: 'Sync charts' });
        expect(screen.getByRole('region', { name: 'Recent chart installs' })).not.toHaveTextContent('private-token');
    });

    it('surfaces sync when bytes changed despite an unchanged id, edition and size', async () => {
        mocks.getCoverage.mockReturnValue([
            {
                id: 'TESTCELL',
                sourceHO: 'TEST',
                bbox: [0, 0, 1, 1],
                edition: 1,
                issued: '2026-09-27',
                importedAt: '2026-09-27',
                hazardCount: 1,
                sizeBytes: 100,
                contentSha256: 'a'.repeat(64),
            },
        ]);
        mocks.listPiInstalledCharts.mockResolvedValue([
            { cellId: 'TESTCELL', edition: 1, sizeBytes: 100, contentSha256: 'b'.repeat(64) },
        ]);
        render(<EncCellManager />);
        fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
        expect(await screen.findByRole('button', { name: /Sync 1 chart from Pi/ })).toBeInTheDocument();
    });
});
