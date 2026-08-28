import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CrewPhoneVerificationPanel } from '../components/crew-finder/CrewPhoneVerificationPanel';
import type { CrewPhoneVerificationController } from '../hooks/useCrewPhoneVerification';

function controller(overrides: Partial<CrewPhoneVerificationController> = {}): CrewPhoneVerificationController {
    return {
        signedIn: true,
        loading: false,
        status: { verified: false, last4: null, verifiedAt: null, emailVerified: true },
        pending: null,
        publicationState: 'blocked',
        publicationReady: false,
        countryCode: 'AU',
        localNumber: '',
        code: '',
        error: '',
        starting: false,
        checking: false,
        removing: false,
        cooldownSeconds: 0,
        setCountryCode: vi.fn(),
        setLocalNumber: vi.fn(),
        setCode: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        check: vi.fn().mockResolvedValue(undefined),
        resend: vi.fn().mockResolvedValue(undefined),
        changeNumber: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        refresh: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('CrewPhoneVerificationPanel', () => {
    it('shows neutral checking chips and a retry action when status cannot be confirmed', () => {
        const { rerender } = render(
            <CrewPhoneVerificationPanel
                controller={controller({ loading: true, publicationState: 'checking', status: null })}
            />,
        );

        expect(screen.getByText('… Checking email')).toBeInTheDocument();
        expect(screen.getByText('… Checking mobile')).toBeInTheDocument();
        expect(screen.queryByText(/email needed/i)).not.toBeInTheDocument();

        const retry = vi.fn().mockResolvedValue(undefined);
        rerender(
            <CrewPhoneVerificationPanel
                controller={controller({
                    publicationState: 'unavailable',
                    status: null,
                    error: 'Phone verification could not be completed.',
                    refresh: retry,
                })}
            />,
        );
        expect(screen.getByText('? Email unknown')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Retry trust check' }));
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('collects a country and local number without exposing it as profile copy', () => {
        const state = controller({ localNumber: '0412 345 678' });
        render(<CrewPhoneVerificationPanel controller={state} />);

        expect(screen.getByRole('heading', { name: 'Verify your mobile' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('AU');
        expect(screen.getByRole('textbox', { name: 'Mobile number' })).toHaveAttribute('autocomplete', 'tel-national');
        fireEvent.change(screen.getByRole('textbox', { name: 'Mobile number' }), {
            target: { value: '04ab12 345 678' },
        });
        expect(state.setLocalNumber).toHaveBeenCalledWith('04ab12 345 678');

        fireEvent.click(screen.getByRole('button', { name: 'Send verification code' }));
        expect(state.start).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/never shown on your crew list profile/i)).toBeInTheDocument();
    });

    it('provides an accessible one-time-code step and honours the resend cooldown', () => {
        const state = controller({
            pending: {
                status: 'pending',
                last4: '6789',
                retryAfterSeconds: 30,
                expiresAt: '2026-08-28T00:05:00.000Z',
            },
            code: '123456',
            cooldownSeconds: 19,
        });
        render(<CrewPhoneVerificationPanel controller={state} />);

        const code = screen.getByRole('textbox', { name: 'Six-digit verification code' });
        expect(code).toHaveAttribute('inputmode', 'numeric');
        expect(code).toHaveAttribute('autocomplete', 'one-time-code');
        fireEvent.change(code, { target: { value: '12a34 56' } });
        expect(state.setCode).toHaveBeenCalledWith('12a34 56');

        fireEvent.click(screen.getByRole('button', { name: 'Verify mobile' }));
        expect(state.check).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'Resend in 19s' })).toBeDisabled();
    });

    it('honours a server retry window even when no local challenge is present', () => {
        render(
            <CrewPhoneVerificationPanel
                controller={controller({ localNumber: '0412 345 678', cooldownSeconds: 12 })}
            />,
        );

        expect(screen.getByRole('button', { name: 'Try again in 12s' })).toBeDisabled();
    });

    it('shows only a masked verified number and both trust checks', () => {
        render(
            <CrewPhoneVerificationPanel
                controller={controller({
                    status: {
                        verified: true,
                        last4: '6789',
                        verifiedAt: '2026-08-28T00:00:00.000Z',
                        emailVerified: true,
                    },
                    publicationReady: true,
                    publicationState: 'ready',
                })}
            />,
        );

        expect(screen.getByText('✓ Email verified')).toBeInTheDocument();
        expect(screen.getByText('✓ Mobile verified')).toBeInTheDocument();
        expect(screen.getByText(/number ending •••• 6789/i)).toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: 'Mobile number' })).not.toBeInTheDocument();
    });

    it('requires an in-panel confirmation before removing a verified number', () => {
        const state = controller({
            status: {
                verified: true,
                last4: '6789',
                verifiedAt: '2026-08-28T00:00:00.000Z',
                emailVerified: true,
            },
            publicationReady: true,
            publicationState: 'ready',
        });
        render(<CrewPhoneVerificationPanel controller={state} />);

        fireEvent.click(screen.getByRole('button', { name: 'Change verified number' }));
        expect(state.remove).not.toHaveBeenCalled();
        expect(screen.getByText(/immediately takes your crew list profile private/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Make private & change' }));
        expect(state.remove).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'Change verified number' })).toBeInTheDocument();
        expect(screen.queryByText(/immediately takes your crew list profile private/i)).not.toBeInTheDocument();
    });
});
