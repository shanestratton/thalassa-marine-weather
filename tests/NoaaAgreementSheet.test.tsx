import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const service = vi.hoisted(() => ({ load: vi.fn(), accept: vi.fn() }));
vi.mock('../services/enc/noaaAgreement', () => ({
    loadNoaaAgreementText: service.load,
    acceptNoaaAgreement: service.accept,
    NOAA_AGREEMENT_URL: 'https://charts.noaa.gov/ENCs/ENC_Agreement.shtml',
    NOAA_ENC_ORIGIN: 'https://charts.noaa.gov/ENCs/',
}));
import NoaaAgreementSheet from '../components/map/NoaaAgreementSheet';
import { ModalSheet } from '../components/ui/ModalSheet';
beforeEach(() => {
    setAuthIdentityScope('00000000-0000-4000-8000-000000000001');
    service.load.mockReset().mockResolvedValue('USER AGREEMENT\nThe exact verified NOAA terms.');
    service.accept.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);
describe('NOAA agreement consent sheet', () => {
    it('requires loaded full terms and explicit checkbox consent before saving; credits and warnings remain visible', async () => {
        const accepted = vi.fn();
        render(<NoaaAgreementSheet onClose={vi.fn()} onAccepted={accepted} />);
        const button = screen.getByRole('button', { name: 'Accept NOAA agreement' });
        expect(button).toBeDisabled();
        await screen.findByLabelText('NOAA ENC User Agreement');
        expect(screen.getByText(/not certified NOAA ENC products/)).toBeVisible();
        expect(screen.getByRole('link', { name: 'NOAA source' })).toHaveAttribute(
            'href',
            'https://charts.noaa.gov/ENCs/',
        );
        expect(button).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(button);
        await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
        expect(service.accept).toHaveBeenCalledWith(
            'USER AGREEMENT\nThe exact verified NOAA terms.',
            expect.objectContaining({ key: 'user:00000000-0000-4000-8000-000000000001' }),
        );
    });
    it('does not claim consent if the local terms or durable write fail', async () => {
        const accepted = vi.fn();
        service.load.mockRejectedValueOnce(Error('Missing local terms'));
        const rendered = render(<NoaaAgreementSheet onClose={vi.fn()} onAccepted={accepted} />);
        expect(await screen.findByRole('alert')).toHaveTextContent('could not be opened');
        expect(screen.getByRole('checkbox')).toBeDisabled();
        rendered.unmount();
        service.accept.mockResolvedValueOnce(false);
        render(<NoaaAgreementSheet onClose={vi.fn()} onAccepted={accepted} />);
        await screen.findByLabelText('NOAA ENC User Agreement');
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: 'Accept NOAA agreement' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Acceptance could not be saved');
        expect(accepted).not.toHaveBeenCalled();
    });
    it('closes and clears consent immediately when the active account changes', async () => {
        const close = vi.fn(),
            accepted = vi.fn();
        render(<NoaaAgreementSheet onClose={close} onAccepted={accepted} />);
        await screen.findByLabelText('NOAA ENC User Agreement');
        fireEvent.click(screen.getByRole('checkbox'));
        act(() => {
            setAuthIdentityScope('00000000-0000-4000-8000-000000000002');
        });
        expect(close).toHaveBeenCalledOnce();
        expect(screen.getByRole('checkbox')).not.toBeChecked();
        expect(screen.getByRole('button', { name: 'Accept NOAA agreement' })).toBeDisabled();
        expect(accepted).not.toHaveBeenCalled();
    });
    it('stacks above a parent sheet and Escape returns focus to the opener without closing the parent', async () => {
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <ModalSheet isOpen title="Marine places" onClose={() => undefined} zIndex="z-10060">
                        <button onClick={() => setOpen(true)}>Read NOAA agreement</button>
                    </ModalSheet>
                    {open && <NoaaAgreementSheet onClose={() => setOpen(false)} onAccepted={() => setOpen(false)} />}
                </>
            );
        }
        render(<Harness />);
        const opener = screen.getByRole('button', { name: 'Read NOAA agreement' });
        opener.focus();
        fireEvent.click(opener);
        const child = await screen.findByRole('dialog', { name: 'NOAA chart agreement' });
        expect(child).toHaveClass('z-10070');
        await within(child).findByLabelText('NOAA ENC User Agreement');
        await waitFor(() => expect(child.contains(document.activeElement)).toBe(true));
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'NOAA chart agreement' })).toBeNull());
        expect(screen.getByRole('dialog', { name: 'Marine places' })).toBeVisible();
        await waitFor(() => expect(opener).toHaveFocus());
    });
});
