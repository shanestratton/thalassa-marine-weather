import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackSubmission } from '../src/feedbackSubmission';

const submission: FeedbackSubmission = {
    clientSubmissionId: '123e4567-e89b-42d3-a456-426614174000',
    kind: 'bug',
    name: 'Shane Stratton',
    email: 'skipper@example.com',
    area: 'weather',
    title: 'Forecast card freezes',
    details: 'The forecast card stops updating after returning from OBS.',
    impact: 'annoying',
    stepsToReproduce: 'Open OBS, then return.',
    expectedResult: 'The forecast updates.',
    actualResult: 'The forecast stays stale.',
    problemToSolve: '',
    idealOutcome: '',
    device: 'iPhone 15 Pro',
    appVersion: '1.2.3',
    appBuild: '123',
    appPlatform: 'iOS',
    diagnostics: null,
    source: 'direct',
    consent: true,
    consentVersion: 'product-feedback-v1',
    website: '',
};

describe('feedback submission client', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co/');
        window.history.replaceState({}, '', '/feedback?source=club_flyer&type=bug&secret=do-not-copy');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('validates source and type query values without reflecting arbitrary input', async () => {
        const { appContextFromLocation, kindFromLocation, sourceFromLocation } =
            await import('../src/feedbackSubmission');

        expect(sourceFromLocation()).toBe('club_flyer');
        expect(kindFromLocation()).toBe('bug');
        expect(sourceFromLocation({ search: '?source=%3Cscript%3E' } as Location)).toBe('direct');
        expect(kindFromLocation({ search: '?type=anything' } as Location)).toBe('bug');
        expect(kindFromLocation({ search: '?type=FEATURE' } as Location)).toBe('feature');
        expect(
            appContextFromLocation({
                search: '?appVersion=%20%EF%BC%91.%EF%BC%92.%EF%BC%90%20&build=123&platform=iOS',
            } as Location),
        ).toEqual({ appVersion: '1.2.0', appBuild: '123', appPlatform: 'iOS' });
        expect(
            appContextFromLocation({
                search: `?appVersion=${'x'.repeat(41)}&build=12%003&platform=iOS%0Adevice`,
            } as Location),
        ).toEqual({ appVersion: '', appBuild: '', appPlatform: '' });
    });

    it('captures only the disclosed bounded diagnostics and strips URL parameters', async () => {
        const { captureFeedbackDiagnostics } = await import('../src/feedbackSubmission');
        const diagnostics = captureFeedbackDiagnostics();

        expect(Object.keys(diagnostics).sort()).toEqual(
            ['currentPath', 'language', 'online', 'platform', 'screen', 'userAgent', 'viewport'].sort(),
        );
        expect(diagnostics.currentPath).toBe('/feedback');
        expect(JSON.stringify(diagnostics)).not.toContain('secret');
        expect(diagnostics.userAgent.length).toBeLessThanOrEqual(512);
        expect(diagnostics.platform.length).toBeLessThanOrEqual(120);
    });

    it('posts to the public feedback endpoint and returns a validated receipt', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ ok: true, reference: 'THA-7K3P9Q' }), {
                status: 202,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const { submitProductFeedback } = await import('../src/feedbackSubmission');

        await expect(submitProductFeedback(submission)).resolves.toEqual({ reference: 'THA-7K3P9Q' });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://project.supabase.co/functions/v1/feedback-submission',
            expect.objectContaining({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(submission),
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it('fails closed on a malformed receipt instead of claiming success', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ ok: true, reference: '<script>' }), {
                    status: 202,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        );
        const { submitProductFeedback } = await import('../src/feedbackSubmission');

        await expect(submitProductFeedback(submission)).rejects.toThrow('could not read the receipt');
    });

    it('uses a bounded server message and a local fallback for an unreadable error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: 'Feedback is temporarily unavailable.' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        );
        let module = await import('../src/feedbackSubmission');
        await expect(module.submitProductFeedback(submission)).rejects.toThrow('temporarily unavailable');

        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('provider details', { status: 502 })));
        module = await import('../src/feedbackSubmission');
        await expect(module.submitProductFeedback(submission)).rejects.toThrow(
            'We could not send that feedback. Please try again.',
        );
    });
});
