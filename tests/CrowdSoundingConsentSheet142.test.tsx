import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const ports = vi.hoisted(() => ({ read: vi.fn(), flush: vi.fn(), off: vi.fn(), save: vi.fn() }));
vi.mock('../services/seabed/crowdConsent', () => ({
    readCrowdPermission: ports.read,
    flushCrowdRevoke: ports.flush,
    revokeCrowdPermission: ports.off,
    saveCrowdPermission: ports.save,
}));
vi.mock('../components/ui/ModalSheet', () => ({
    ModalSheet: ({ children, footer }: React.PropsWithChildren<{ footer: React.ReactNode }>) => (
        <div role="dialog">
            {children}
            <footer>{footer}</footer>
        </div>
    ),
}));
import CrowdSoundingConsentSheet from '../components/settings/CrowdSoundingConsentSheet';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const boatId = '22222222-2222-4222-8222-222222222222';
const owner = '11111111-1111-4111-8111-111111111111';
const loaded = { boatId, boatName: 'Fictional owned boat', permission: null, pendingRevoke: false };
beforeEach(() => {
    setAuthIdentityScope(owner);
    Object.values(ports).forEach((mock) => mock.mockReset());
    ports.flush.mockResolvedValue(true);
    ports.read.mockResolvedValue(loaded);
    ports.off.mockResolvedValue('saved');
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 17, 12));
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});
it('keeps independent public choices OFF until explicitly saved, and requires measured fields', async () => {
    render(<CrowdSoundingConsentSheet boatId={boatId} onClose={vi.fn()} />);
    await screen.findByText(/Fictional owned boat/);
    const checks = screen.getAllByRole('checkbox');
    expect(checks.every((check) => !(check as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(checks[0]);
    fireEvent.click(checks[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Save choices' }));
    await screen.findByText(/Saving could not be confirmed/);
    expect(ports.save).not.toHaveBeenCalled();
    expect(ports.off).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Instrument depth reference'), { target: { value: 'T' } });
    fireEvent.change(screen.getByLabelText('Exact instrument source identifier'), {
        target: { value: 'fixture:transducer' },
    });
    fireEvent.change(screen.getByLabelText('Sounder make and model'), { target: { value: 'Fictional sounder' } });
    fireEvent.change(screen.getByLabelText('Calibration date and time (UTC)'), {
        target: { value: '2026-10-17T10:30' },
    });
    for (const [label, value] of [
        ['Measured waterline to transducer (m)', '0.8'],
        ['Offset uncertainty bound (m)', '0.1'],
        ['Sounder uncertainty bound (m)', '0.2'],
        ['Maximum depth actually checked (m)', '30'],
    ])
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(checks[2]);
    ports.save.mockResolvedValue({
        revision: '33333333-3333-4333-8333-333333333333',
        mapEnabled: true,
        dcdbEnabled: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save choices' }));
    await screen.findByText(/Choices saved for future captures/);
    expect(ports.save).toHaveBeenCalledOnce();
    expect(ports.save.mock.calls[0][0]).toMatchObject({
        boatId,
        expectedRevision: null,
        mapEnabled: true,
        dcdbEnabled: false,
        calibration: { depthReference: 'T', waterlineToTransducerM: 0.8, measuredAt: Date.UTC(2026, 9, 17, 10, 30) },
    });
});
it('retains truthful pending OFF even when ownership/settings cannot be loaded', async () => {
    ports.read.mockRejectedValue(new Error('offline'));
    ports.off.mockResolvedValue('pending');
    render(<CrowdSoundingConsentSheet boatId={boatId} onClose={vi.fn()} />);
    await screen.findByText(/Current sharing settings are unavailable/);
    fireEvent.click(screen.getByRole('button', { name: 'Turn both permissions OFF' }));
    await screen.findByText(/OFF is saved on this device and pending delivery/);
    expect(ports.off).toHaveBeenCalledWith(boatId);
    expect(screen.getByRole('button', { name: 'Save choices' })).toBeDisabled();
    expect(ports.save).not.toHaveBeenCalled();
});
it('retires a late read across owner A/B/A and closes without adopting it', async () => {
    let resolve!: (value: typeof loaded) => void;
    ports.read.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const close = vi.fn();
    render(<CrowdSoundingConsentSheet boatId={boatId} onClose={close} />);
    await waitFor(() => expect(ports.read).toHaveBeenCalledOnce());
    setAuthIdentityScope('44444444-4444-4444-8444-444444444444');
    setAuthIdentityScope(owner);
    resolve(loaded);
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(screen.queryByText(/Fictional owned boat/)).not.toBeInTheDocument();
    expect(ports.save).not.toHaveBeenCalled();
});
