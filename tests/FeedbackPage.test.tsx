import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackPage } from '../src/FeedbackPage';

function completeCommonFields(kind: 'bug' | 'feature' = 'bug'): void {
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '  Shane   Stratton  ' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'SKIPPER@EXAMPLE.COM' } });
    fireEvent.change(screen.getByLabelText('Area of Thalassa'), { target: { value: 'weather' } });
    fireEvent.change(screen.getByLabelText('Short title'), { target: { value: '  Forecast card freezes  ' } });
    fireEvent.change(screen.getByLabelText('Details'), {
        target: { value: '  The forecast card stops updating after I return from OBS.  ' },
    });
    fireEvent.click(screen.getByLabelText(kind === 'bug' ? 'Annoying' : 'Important'));
    fireEvent.click(screen.getByLabelText(/I agree that Thalassa may use these details/i));
}

describe('FeedbackPage', () => {
    beforeEach(() => {
        window.history.replaceState({}, '', '/feedback?source=direct');
    });

    it('honours a valid feature deep link and rejects an unsafe source value', () => {
        window.history.replaceState(
            {},
            '',
            '/feedback?type=feature&source=%3Cscript%3E&appVersion=%201.2.0%20&build=123&platform=iOS',
        );
        const submit = vi.fn();
        render(<FeedbackPage submitFeedback={submit} />);

        expect(screen.getByLabelText('Request a feature')).toBeChecked();
        expect(screen.getByLabelText('What problem would this solve?')).toBeInTheDocument();
        expect(screen.queryByLabelText('Include basic technical details')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Report context from app link')).toHaveTextContent('iOS · v1.2.0 · build 123');
        expect(screen.getByText(/These details came from the app link/i)).toBeInTheDocument();
    });

    it('announces strict validation errors without submitting incomplete details', () => {
        const submit = vi.fn();
        render(<FeedbackPage submitFeedback={submit} />);

        fireEvent.click(screen.getByRole('button', { name: 'Send bug report' }));

        expect(screen.getByRole('alert')).toHaveTextContent('Check the highlighted fields');
        expect(screen.getByText('Add your name.')).toBeInTheDocument();
        expect(screen.getByText('Add a little more detail (at least 20 characters).')).toBeInTheDocument();
        expect(screen.getByText('Tell us how much this matters.')).toBeInTheDocument();
        expect(submit).not.toHaveBeenCalled();
    });

    it('normalizes and submits an opted-in bug once, then shows its receipt reference', async () => {
        window.history.replaceState(
            {},
            '',
            '/feedback?type=bug&source=app_settings&appVersion=1.2.0&build=123&platform=iOS',
        );
        let resolveSubmission: ((value: { reference: string }) => void) | undefined;
        const submit = vi.fn(
            () =>
                new Promise<{ reference: string }>((resolve) => {
                    resolveSubmission = resolve;
                }),
        );
        render(<FeedbackPage submitFeedback={submit} />);
        completeCommonFields('bug');
        expect(screen.getByLabelText('Thalassa version')).toHaveValue('1.2.0');
        expect(screen.getByLabelText('Thalassa version')).toHaveAttribute('readonly');
        expect(screen.getByText('Added by the app link and locked to this report.')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Steps to reproduce'), {
            target: { value: 'Open OBS\nReturn to The Glass' },
        });
        fireEvent.change(screen.getByLabelText('Device'), { target: { value: 'iPhone 15 Pro' } });
        fireEvent.click(screen.getByLabelText('Include basic technical details'));

        const button = screen.getByRole('button', { name: 'Send bug report' });
        fireEvent.click(button);
        fireEvent.submit(button.closest('form') as HTMLFormElement);

        expect(submit).toHaveBeenCalledOnce();
        expect(submit).toHaveBeenCalledWith(
            expect.objectContaining({
                clientSubmissionId: expect.stringMatching(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
                ),
                kind: 'bug',
                name: 'Shane Stratton',
                email: 'skipper@example.com',
                area: 'weather',
                title: 'Forecast card freezes',
                details: 'The forecast card stops updating after I return from OBS.',
                impact: 'annoying',
                stepsToReproduce: 'Open OBS\nReturn to The Glass',
                problemToSolve: '',
                idealOutcome: '',
                appVersion: '1.2.0',
                appBuild: '123',
                appPlatform: 'iOS',
                source: 'app_settings',
                consent: true,
                consentVersion: 'product-feedback-v1',
                website: '',
                diagnostics: expect.objectContaining({
                    currentPath: '/feedback',
                    online: expect.any(Boolean),
                    userAgent: expect.any(String),
                }),
            }),
        );
        expect(button).toBeDisabled();

        resolveSubmission?.({ reference: 'THA-7K3P9Q' });
        expect(await screen.findByRole('heading', { name: 'Report received.' })).toBeInTheDocument();
        expect(screen.getByText('Reference: THA-7K3P9Q')).toBeInTheDocument();
        expect(screen.getByText(/Reply to the receipt email with screenshots/i)).toBeInTheDocument();
    });

    it('requires useful feature context and never includes diagnostics for a feature', async () => {
        window.history.replaceState(
            {},
            '',
            '/feedback?type=feature&source=club_flyer&appVersion=2.0.0&build=456&platform=iPadOS',
        );
        const submit = vi.fn().mockResolvedValue({ reference: 'THA-FEATURE-1' });
        render(<FeedbackPage submitFeedback={submit} />);
        completeCommonFields('feature');

        fireEvent.click(screen.getByRole('button', { name: 'Send feature request' }));
        expect(screen.getByText('Tell us what problem this would solve.')).toBeInTheDocument();
        expect(screen.getByText('Describe what a great version would do.')).toBeInTheDocument();
        expect(submit).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText('What problem would this solve?'), {
            target: { value: 'It is hard to compare two departure windows.' },
        });
        fireEvent.change(screen.getByLabelText('What would a great version look like?'), {
            target: { value: 'Show both departure windows side by side.' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send feature request' }));

        await waitFor(() => expect(submit).toHaveBeenCalledOnce());
        expect(submit).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'feature',
                impact: 'important',
                problemToSolve: 'It is hard to compare two departure windows.',
                idealOutcome: 'Show both departure windows side by side.',
                stepsToReproduce: '',
                expectedResult: '',
                actualResult: '',
                device: '',
                appVersion: '2.0.0',
                appBuild: '456',
                appPlatform: 'iPadOS',
                diagnostics: null,
                source: 'club_flyer',
            }),
        );
    });

    it('keeps a failed report available for retry with the same idempotency id', async () => {
        const submit = vi
            .fn()
            .mockRejectedValueOnce(new Error('Feedback is temporarily unavailable. Please try again.'))
            .mockResolvedValueOnce({ reference: 'THA-RETRY-1' });
        render(<FeedbackPage submitFeedback={submit} />);
        completeCommonFields('bug');
        expect(screen.getByLabelText('Thalassa version')).not.toHaveAttribute('readonly');
        fireEvent.change(screen.getByLabelText('Thalassa version'), { target: { value: '9.9.9-manual' } });

        fireEvent.click(screen.getByRole('button', { name: 'Send bug report' }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable'));

        fireEvent.click(screen.getByRole('button', { name: 'Send bug report' }));
        await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
        expect(submit.mock.calls[1][0].clientSubmissionId).toBe(submit.mock.calls[0][0].clientSubmissionId);
        expect(submit.mock.calls[1][0]).toEqual(
            expect.objectContaining({ appVersion: '9.9.9-manual', appBuild: '', appPlatform: '' }),
        );
    });
});
