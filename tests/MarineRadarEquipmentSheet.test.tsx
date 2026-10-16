import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../services/radar/radarEquipmentRead', () => ({ checkPairedRadarEquipment: f.check }));
vi.mock('../services/radar/piRadar', () => ({
    PiRadarError: class extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    },
}));
import Sheet from '../components/settings/MarineRadarEquipmentSheet';
const original = { schema: 1 as const, make: 'raymarine' as const, modelId: null, detail: null };
beforeEach(() => {
    f.check.mockReset();
});
afterEach(cleanup);
it('starts with no choice, saves a confirmed selection only on Save, and clears with JSON null', () => {
    const save = vi.fn();
    render(<Sheet value={null} canDetect isCurrent={() => true} onSave={save} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Make')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Make'), { target: { value: 'raymarine' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'raymarine-quantum-2' } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save equipment' }));
    expect(save).toHaveBeenCalledWith({ ...original, modelId: 'raymarine-quantum-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear equipment' }));
    expect(save).toHaveBeenLastCalledWith(null);
});
it('auto-detect reports paired feed/model unknown, and cannot replace a saved selection', async () => {
    const save = vi.fn();
    f.check.mockResolvedValue({
        source: 'paired-pi-target-feed',
        model: null,
        piName: 'Synthetic Pi',
        configured: true,
        connected: true,
        overloaded: false,
        checkedAt: Date.now(),
        lastFrameAt: Date.now(),
        isCurrent: () => true,
    });
    render(
        <Sheet
            value={{ ...original, modelId: 'raymarine-quantum-2' }}
            canDetect
            isCurrent={() => true}
            onSave={save}
            onClose={vi.fn()}
        />,
    );
    expect(f.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Auto-detect' }));
    await screen.findByText('Paired Pi feed: Synthetic Pi');
    expect(screen.getByText(/Scanner model unknown/)).toHaveTextContent('does not verify which fleet vessel');
    expect(screen.getByLabelText('Model')).toHaveValue('raymarine-quantum-2');
    expect(save).not.toHaveBeenCalled();
});
it('cancels a pending check and discards its late result without touching the manual draft', async () => {
    let resolve!: (value: unknown) => void;
    f.check.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    render(<Sheet value={original} canDetect isCurrent={() => true} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auto-detect' }));
    const request = f.check.mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Cancel check' }));
    expect(request.signal.aborted).toBe(true);
    await act(async () => resolve({ piName: 'Late Pi', isCurrent: () => true }));
    expect(screen.queryByText(/Late Pi/)).toBeNull();
    expect(screen.getByLabelText('Make')).toHaveValue('raymarine');
});
it('fences account/vessel retirement before saving or accepting a read', async () => {
    const save = vi.fn(),
        close = vi.fn();
    let current = true,
        resolve!: (v: unknown) => void;
    f.check.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    render(<Sheet value={original} canDetect isCurrent={() => current} onSave={save} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auto-detect' }));
    current = false;
    await act(async () => resolve({ piName: 'Late owner', isCurrent: () => true }));
    expect(screen.queryByText(/Late owner/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save equipment' }));
    expect(save).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
});
it('offers manual make-known/model-unknown and refuses detection without a saved vessel', async () => {
    const save = vi.fn();
    render(<Sheet value={original} canDetect={false} isCurrent={() => true} onSave={save} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auto-detect' }));
    expect(f.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save equipment' }));
    expect(save).toHaveBeenCalledWith(original);
    await waitFor(() => expect(screen.getByText(/Select a saved vessel/)).toBeVisible());
});
