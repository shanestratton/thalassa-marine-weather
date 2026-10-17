import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { stageOpenedChart, peekOpenedChart } from '../services/charts/openedChartQueue';
import type { LocalChartRecord } from '../services/charts/localChartLibraryContract';

const service = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('../services/charts/localChartLibrary', () => ({
    listLocalCharts: service.list,
    importLocalChart: service.save,
    removeLocalChart: service.remove,
    subscribeLocalChartLibrary: () => () => undefined,
}));
import LocalChartLibrarySheet from '../components/map/LocalChartLibrarySheet';
const chart: LocalChartRecord = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'My own chart.mbtiles',
    kind: 'mbtiles',
    bytes: 512,
    rights: 'own',
    importedAt: Date.UTC(2026, 9, 17),
    sha256: 'a'.repeat(64),
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}
const view = (activeId: string | null = null) => {
    const props = { onClose: vi.fn(), onDisplay: vi.fn(), onStop: vi.fn(), activeId, status: '' };
    return { ...render(<LocalChartLibrarySheet {...props} />), props };
};
beforeEach(() => {
    service.list.mockReset().mockResolvedValue([]);
    service.save.mockReset().mockResolvedValue(chart);
    service.remove.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope('a');
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});
describe('actual private chart library controls', () => {
    it('refuses an attachment whose process-local admission expired while the sheet stayed open', async () => {
        let now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            stageOpenedChart('file:///Inbox/chart.kap');
            view();
            fireEvent.click(screen.getByRole('radio', { name: /I created this chart/ }));
            now += 5 * 60 * 1000 + 1;
            fireEvent.click(screen.getByRole('button', { name: 'Import this attachment' }));
            expect(service.save).not.toHaveBeenCalled();
            expect(screen.getByText(/opened attachment expired/)).toBeVisible();
        } finally {
            clock.mockRestore();
        }
    });
    it('fences a stale still-mounted input synchronously on an account transition', async () => {
        view();
        fireEvent.click(screen.getByRole('radio', { name: /I created this chart/ }));
        act(() => setAuthIdentityScope('b'));
        fireEvent.change(screen.getByLabelText('Choose local chart file'), {
            target: { files: [new File(['x'], 'old-owner.kap')] },
        });
        expect(service.save).not.toHaveBeenCalled();
    });
    it('requires an explicit own/open choice and lists closed charts without opening them', async () => {
        service.list.mockResolvedValue([chart]);
        const f = view();
        const importButton = screen.getByRole('button', { name: 'Import a chart file' });
        expect(importButton).toBeDisabled();
        expect(await screen.findByText(chart.name)).toBeVisible();
        expect(service.save).not.toHaveBeenCalled();
        expect(f.props.onDisplay).not.toHaveBeenCalled();
        expect(screen.getByText(/Licensed or encrypted commercial charts stay/)).toBeVisible();
    });
    it('passes the selected rights and real file to import, resets consent and offers explicit Display', async () => {
        service.list.mockResolvedValueOnce([]).mockResolvedValue([chart]);
        const f = view();
        await waitFor(() => expect(service.list).toHaveBeenCalledOnce());
        fireEvent.click(screen.getByRole('radio', { name: /I created this chart/ }));
        const file = new File(['own fixture'], 'my-own.mbtiles');
        fireEvent.change(screen.getByLabelText('Choose local chart file'), { target: { files: [file] } });
        await waitFor(() =>
            expect(service.save).toHaveBeenCalledWith(
                file,
                'own',
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ),
        );
        expect(await screen.findByText('Saved privately. Choose Display to open this chart.')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Import a chart file' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Display' }));
        expect(f.props.onDisplay).toHaveBeenCalledWith(chart.id);
    });
    it('aborts an outstanding import when Done closes the sheet and cannot publish a late success', async () => {
        const pending = deferred<LocalChartRecord>();
        service.save.mockReturnValue(pending.promise);
        const f = view();
        fireEvent.click(screen.getByRole('radio', { name: /open licence permitting/ }));
        fireEvent.change(screen.getByLabelText('Choose local chart file'), {
            target: { files: [new File(['x'], 'own.kap')] },
        });
        await waitFor(() => expect(service.save).toHaveBeenCalledOnce());
        const options = service.save.mock.calls[0][2];
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(options.signal.aborted).toBe(true);
        expect(f.props.onClose).toHaveBeenCalledOnce();
        f.unmount();
        await act(async () => {
            pending.resolve(chart);
            await pending.promise;
        });
        expect(options.isCurrent()).toBe(false);
        expect(screen.queryByText(chart.name)).not.toBeInTheDocument();
    });
    it('drops a late owner-A listing across A/B/A even if the parent has not yet unmounted the sheet', async () => {
        const pending = deferred<LocalChartRecord[]>();
        service.list.mockReturnValue(pending.promise);
        const f = view();
        await waitFor(() => expect(service.list).toHaveBeenCalledOnce());
        act(() => {
            setAuthIdentityScope('b');
            setAuthIdentityScope('a');
        });
        await act(async () => {
            pending.resolve([chart]);
            await pending.promise;
        });
        expect(f.props.onClose).toHaveBeenCalledTimes(2);
        expect(screen.queryByText(chart.name)).not.toBeInTheDocument();
    });
    it('closes the selected overlay before issuing Remove and fences its pending action on close', async () => {
        service.list.mockResolvedValue([chart]);
        const pending = deferred<void>();
        service.remove.mockReturnValue(pending.promise);
        const f = view(chart.id);
        await screen.findByText(chart.name);
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        expect(f.props.onStop).toHaveBeenCalledOnce();
        expect(service.remove).toHaveBeenCalledWith(chart.id, expect.any(Object));
        const options = service.remove.mock.calls[0][1];
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(options.signal.aborted).toBe(true);
        f.unmount();
        await act(async () => {
            pending.resolve();
            await pending.promise;
        });
        expect(options.isCurrent()).toBe(false);
    });
    it('shows an opened URI but performs no copy until the explicit attachment import and rights choice', async () => {
        stageOpenedChart('file:///Inbox/Own%20satellite.kap');
        view();
        expect(screen.getByText('Opened attachment: Own satellite.kap')).toBeVisible();
        const button = screen.getByRole('button', { name: 'Import this attachment' });
        expect(button).toBeDisabled();
        expect(service.save).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('radio', { name: /I created this chart/ }));
        fireEvent.click(button);
        await waitFor(() =>
            expect(service.save).toHaveBeenCalledWith(
                expect.objectContaining({ url: 'file:///Inbox/Own%20satellite.kap', name: 'Own satellite.kap' }),
                'own',
                expect.any(Object),
            ),
        );
        await waitFor(() => expect(peekOpenedChart()).toBeNull());
    });
});
