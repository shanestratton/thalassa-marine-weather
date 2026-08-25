import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundingSkippersPage } from '../src/FoundingSkippersPage';

function completeRequiredFields(): void {
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Shane Stratton' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'SKIPPER@EXAMPLE.COM' } });
    fireEvent.change(screen.getByLabelText('Boat type'), { target: { value: 'sail_monohull' } });
    fireEvent.change(screen.getByLabelText('Apple device'), { target: { value: 'iphone_and_ipad' } });
    fireEvent.change(screen.getByLabelText(/^Home waters/), { target: { value: 'Moreton Bay' } });
    fireEvent.change(screen.getByLabelText('How often are you on the water?'), {
        target: { value: 'weekly_plus' },
    });
    fireEvent.click(screen.getByLabelText('Marine weather'));
    fireEvent.click(screen.getByLabelText(/I agree that Thalassa may use these details to assess my application/));
}

describe('FoundingSkippersPage', () => {
    beforeEach(() => {
        window.history.replaceState({}, '', '/beta?source=moreton-bay-club');
    });

    it('shows accessible validation without submitting incomplete details', () => {
        const submit = vi.fn();
        render(<FoundingSkippersPage submitApplication={submit} />);

        expect(screen.getByLabelText('Your name')).not.toHaveAttribute('placeholder');

        fireEvent.click(screen.getByRole('button', { name: 'Apply to join the crew' }));

        expect(screen.getByRole('alert')).toHaveTextContent('Check the highlighted fields');
        expect(screen.getByText('Add your name.')).toBeInTheDocument();
        expect(screen.getByText('Choose at least one area to test.')).toBeInTheDocument();
        expect(submit).not.toHaveBeenCalled();
    });

    it('submits normalized details once and renders the success state', async () => {
        let resolveSubmission: (() => void) | undefined;
        const submit = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveSubmission = resolve;
                }),
        );
        render(<FoundingSkippersPage submitApplication={submit} />);
        completeRequiredFields();

        const button = screen.getByRole('button', { name: 'Apply to join the crew' });
        fireEvent.click(button);
        fireEvent.submit(button.closest('form') as HTMLFormElement);

        expect(submit).toHaveBeenCalledOnce();
        expect(submit).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Shane Stratton',
                email: 'skipper@example.com',
                source: 'moreton-bay-club',
                interests: ['marine_weather'],
                consent: true,
                consentVersion: 'founding-skippers-v2',
            }),
        );
        expect(button).toBeDisabled();

        resolveSubmission?.();
        expect(await screen.findByText("We've got your application.")).toBeInTheDocument();
        expect(screen.getByText(/A confirmation email is on its way/i)).toBeInTheDocument();
        expect(screen.getByText(/if you're accepted, email you with the next steps/i)).toBeInTheDocument();
        expect(screen.getByText(/isn't acceptance into the beta yet/i)).toBeInTheDocument();
    });

    it('keeps the form and announces a retryable server failure', async () => {
        const submit = vi
            .fn()
            .mockRejectedValue(new Error('Applications are temporarily unavailable. Please try again.'));
        render(<FoundingSkippersPage submitApplication={submit} />);
        completeRequiredFields();

        fireEvent.click(screen.getByRole('button', { name: 'Apply to join the crew' }));

        await waitFor(() =>
            expect(screen.getByRole('alert')).toHaveTextContent('Applications are temporarily unavailable'),
        );
        expect(screen.getByRole('button', { name: 'Apply to join the crew' })).toBeEnabled();
    });
});
