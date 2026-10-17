import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({
    load: vi.fn(),
    send: vi.fn(),
    clear: vi.fn(),
    accountChanged: null as null | (() => void),
}));
vi.mock('../services/piCourse', () => ({
    previewFollowedCourse: control.load,
    activateFollowedCourse: control.send,
    clearSavedCourseReceipts: control.clear,
    PiCourseError: class PiCourseError extends Error {},
}));
vi.mock('../services/authIdentityScope', () => ({
    subscribeAuthIdentityScope: (listener: () => void) => {
        control.accountChanged = listener;
        return () => {
            control.accountChanged = null;
        };
    },
}));
import FollowedCourseDialog from '../components/map/FollowedCourseDialog';
import { PiCourseError } from '../services/piCourse';
const preview = (extra = {}) => ({
    name: 'Fictional A → Fictional B',
    pointCount: 2,
    replacesDestination: true,
    pilotState: 'unknown',
    expiresAt: Date.now() + 30_000,
    current: () => true,
    token: 'b'.repeat(32),
    digest: 'a'.repeat(64),
    routeKey: 'fictional-a',
    ...extra,
});
beforeEach(() => {
    vi.clearAllMocks();
    control.load.mockResolvedValue(preview());
    control.send.mockResolvedValue(undefined);
    control.clear.mockResolvedValue(1);
});
afterEach(cleanup);
describe('followed-course helm confirmation', () => {
    it('requires both explicit checks before replacing a destination and confirms only after the boat replies', async () => {
        render(<FollowedCourseDialog onClose={() => undefined} />);
        await screen.findByText('Pilot state is not reported. Confirm standby at the helm.');
        const send = screen.getByRole('button', { name: 'Send to plotter' });
        expect(send).toBeDisabled();
        fireEvent.click(screen.getByLabelText(/I am at the helm/));
        expect(send).toBeDisabled();
        fireEvent.click(screen.getByLabelText(/Replace the boat/));
        expect(send).toBeEnabled();
        expect(control.send).not.toHaveBeenCalled();
        fireEvent.click(send);
        await screen.findByText(/Route confirmed on the boat/);
        expect(control.send).toHaveBeenCalledTimes(1);
        expect(control.send.mock.calls[0].slice(1)).toEqual([true, true]);
    });
    it('an active reported pilot cannot be overridden by the checkbox', async () => {
        control.load.mockResolvedValueOnce(preview({ pilotState: 'engaged', replacesDestination: false }));
        render(<FollowedCourseDialog onClose={() => undefined} />);
        await screen.findByText(/boat reports an active pilot/);
        fireEvent.click(screen.getByLabelText(/I am at the helm/));
        expect(screen.getByRole('button', { name: 'Send to plotter' })).toBeDisabled();
        expect(control.send).not.toHaveBeenCalled();
    });
    it('changed or expired followed state requires a new preview', async () => {
        control.load.mockResolvedValueOnce(preview({ current: () => false }));
        render(<FollowedCourseDialog onClose={() => undefined} />);
        await screen.findByText(/confirmation expired/);
        expect(screen.getByRole('button', { name: 'Send to plotter' })).toBeDisabled();
    });
    it('an uncertain reply consumes the visible confirmation and never automatically resends', async () => {
        control.send.mockRejectedValueOnce(new PiCourseError('Sending is unconfirmed. Check the plotter.'));
        render(<FollowedCourseDialog onClose={() => undefined} />);
        await screen.findByText('Pilot state is not reported. Confirm standby at the helm.');
        fireEvent.click(screen.getByLabelText(/I am at the helm/));
        fireEvent.click(screen.getByLabelText(/Replace the boat/));
        fireEvent.click(screen.getByRole('button', { name: 'Send to plotter' }));
        await screen.findByRole('alert');
        expect(screen.queryByRole('button', { name: 'Send to plotter' })).not.toBeInTheDocument();
        expect(control.send).toHaveBeenCalledTimes(1);
        expect(control.load).toHaveBeenCalledTimes(1);
    });
    it('offers explicit recovery of this phone’s sent routes without sending another route', async () => {
        render(<FollowedCourseDialog onClose={() => undefined} />);
        await screen.findByText('Pilot state is not reported. Confirm standby at the helm.');
        fireEvent.click(screen.getByRole('button', { name: 'Clear this phone’s sent routes' }));
        await screen.findByText(/sent route handoffs have been cleared/);
        expect(control.clear).toHaveBeenCalledTimes(1);
        expect(control.send).not.toHaveBeenCalled();
    });
    it('account fencing closes the dialog and a late preview cannot send', async () => {
        let finish!: (value: unknown) => void;
        control.load.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const close = vi.fn();
        const page = render(<FollowedCourseDialog onClose={close} />);
        await waitFor(() => expect(control.accountChanged).toBeTypeOf('function'));
        act(() => control.accountChanged!());
        expect(close).toHaveBeenCalledTimes(1);
        page.unmount();
        await act(async () => finish(preview()));
        expect(control.send).not.toHaveBeenCalled();
    });
});
