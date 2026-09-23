import { test, expect } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

test.use({ storageState: ONBOARDED_STORAGE, serviceWorkers: 'block' });

test('standalone /plan keeps guests behind usable sign-in choices', async ({ page, baseURL }, info) => {
    const origin = new URL(baseURL!).origin;
    let trialRequests = 0;
    // This is an isolated guest/browser check, not a live sign-in or routing
    // request. Only the built application's own static files may load.
    await page.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/functions/v1/autorouting-trial') trialRequests++;
        if (url.origin === origin && request.method() === 'GET' && !url.pathname.startsWith('/api/'))
            return route.continue();
        return route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.goto('/plan');

    const wall = page.getByRole('dialog', { name: 'Sign in to Thalassa', exact: true });
    await expect(wall).toBeVisible();
    await expect(wall.getByRole('button', { name: 'Close sign-in', exact: true })).toHaveCount(0);
    const choices = ['Sign in with email', 'Sign in with Apple', 'Sign in with Google'];
    for (const name of choices) {
        const button = wall.getByRole('button', { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
        // An absolute-positioned footer used to cover Google on short phones.
        // Trial checks hit testing without starting an OAuth flow.
        await button.click({ trial: true });
    }
    const google = wall.getByRole('button', { name: 'Sign in with Google', exact: true });
    const privacy = wall.getByText(/^Signing in enables automatic private cloud sync\./);
    const [googleBox, privacyBox] = await Promise.all([google.boundingBox(), privacy.boundingBox()]);
    expect(googleBox).not.toBeNull();
    expect(privacyBox).not.toBeNull();
    expect(privacyBox!.y).toBeGreaterThanOrEqual(googleBox!.y + googleBox!.height + 8);

    const slider = page.getByRole('button', { name: 'Slide to Start Plotting', exact: true });
    await expect(slider).toHaveCount(1);
    await expect(slider.click({ trial: true, timeout: 750 })).rejects.toThrow();
    await page.keyboard.press('Escape');
    await expect(wall).toBeVisible();
    expect(trialRequests).toBe(0);
    await expect(page.getByRole('dialog', { name: 'Choose routing mode', exact: true })).toHaveCount(0);

    const screenshot = info.outputPath('plan-sign-in-gate.png');
    await page.screenshot({ path: screenshot });
    await info.attach('plan-sign-in-gate', { path: screenshot, contentType: 'image/png' });
});
