import { expect, test, type Page } from '@playwright/test';

type CapturedSubmission = { submission?: Record<string, unknown> };

async function mockFeedbackSubmission(page: Page, reference: string): Promise<CapturedSubmission> {
    const captured: CapturedSubmission = {};

    await page.route('**/functions/v1/feedback-submission', async (route) => {
        const request = route.request();
        if (request.method() === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: {
                    'Access-Control-Allow-Headers': 'content-type',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Origin': '*',
                },
            });
            return;
        }

        expect(request.method()).toBe('POST');
        captured.submission = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
            status: 202,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ ok: true, reference }),
        });
    });

    return captured;
}

test.describe('Product Feedback', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('submits a bug report with explicitly opted-in diagnostics', async ({ page }) => {
        const captured = await mockFeedbackSubmission(page, 'FB-1A2B3C4D');

        await page.goto('/feedback?source=e2e&appVersion=1.2.0&build=123&platform=ios');
        await expect(page).toHaveTitle('Feedback — Thalassa');
        const bugContext = page.getByLabel('Report context from app link');
        await expect(bugContext).toBeVisible();
        await expect(bugContext).toContainText(/iOS.*1\.2\.0.*build.*123/i);

        await page.getByRole('radio', { name: 'Report a bug' }).check();
        await page.getByLabel('Your name').fill('Test Skipper');
        await page.getByLabel('Email').fill('SKIPPER@EXAMPLE.COM');
        await page.getByLabel('Area of Thalassa').selectOption({ index: 1 });
        await page.getByLabel('Short title').fill('Forecast card does not refresh');
        await page
            .getByLabel('Details')
            .fill('The forecast card remains on the previous observation after a manual refresh.');
        await page.getByRole('radio', { name: 'Stops me using it' }).check();
        await page.getByLabel('Steps to reproduce').fill('Open The Glass, wait for an update, then tap refresh.');
        await page.getByLabel('What did you expect?').fill('The latest observation should appear.');
        await page.getByLabel('What actually happened?').fill('The previous observation remained visible.');
        await page.getByLabel('Device').fill('iPhone 17 Pro');
        await page.getByLabel('Include basic technical details').check();
        await page.getByLabel(/I agree that Thalassa may use these details/).check();

        await page.getByRole('button', { name: 'Send bug report' }).click();

        await expect(page.getByRole('heading', { name: 'Report received.' })).toBeVisible();
        await expect(page.getByText('Reference: FB-1A2B3C4D')).toBeVisible();
        const submission = captured.submission;
        expect(submission).toBeDefined();
        expect(submission).toMatchObject({
            kind: 'bug',
            name: 'Test Skipper',
            email: 'skipper@example.com',
            source: 'e2e',
            appVersion: '1.2.0',
            appBuild: '123',
            appPlatform: 'ios',
            consent: true,
            consentVersion: 'product-feedback-v1',
        });
        expect(submission?.diagnostics).toMatchObject({ currentPath: '/feedback' });
        expect(JSON.stringify(submission?.diagnostics)).not.toContain('appVersion=');
        expect(JSON.stringify(submission?.diagnostics)).not.toContain('build=');
        expect(JSON.stringify(submission?.diagnostics)).not.toContain('platform=');
        expect(submission?.problemToSolve).toBe('');
        expect(submission?.idealOutcome).toBe('');
    });

    test('switches to the feature-request questions without collecting diagnostics', async ({ page }) => {
        const captured = await mockFeedbackSubmission(page, 'FB-5E6F7A8B');

        await page.goto('/feedback?source=e2e&appVersion=1.2.0&build=123&platform=ios');
        const featureContext = page.getByLabel('Report context from app link');
        await expect(featureContext).toBeVisible();
        await expect(featureContext).toContainText(/iOS.*1\.2\.0.*build.*123/i);
        await page.getByRole('radio', { name: 'Request a feature' }).check();

        await expect(page.getByLabel('What problem would this solve?')).toBeVisible();
        await expect(page.getByLabel('What would a great version look like?')).toBeVisible();
        await expect(page.getByLabel('Include basic technical details')).toHaveCount(0);

        await page.getByLabel('Your name').fill('Feature Skipper');
        await page.getByLabel('Email').fill('feature@example.com');
        await page.getByLabel('Area of Thalassa').selectOption({ index: 1 });
        await page.getByLabel('Short title').fill('Add a weather comparison view');
        await page
            .getByLabel('Details')
            .fill('Let skippers compare two forecast models over the same passage and departure window.');
        await page.getByRole('radio', { name: 'Important' }).check();
        await page
            .getByLabel('What problem would this solve?')
            .fill('It would make model disagreement easier to understand before departure.');
        await page
            .getByLabel('What would a great version look like?')
            .fill('A clear side-by-side forecast view using the same route and timeline.');
        await page.getByLabel(/I agree that Thalassa may use these details/).check();
        await page.getByRole('button', { name: 'Send feature request' }).click();

        await expect(page.getByText('Reference: FB-5E6F7A8B')).toBeVisible();
        expect(captured.submission).toMatchObject({
            kind: 'feature',
            source: 'e2e',
            appVersion: '1.2.0',
            appBuild: '123',
            appPlatform: 'ios',
            diagnostics: null,
        });
    });
});
