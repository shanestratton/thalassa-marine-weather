import { expect, test } from '@playwright/test';
test.beforeEach(async ({ page }) => {
    await page.route('**/services/piCourse.ts*', (route) =>
        route.fulfill({
            contentType: 'application/javascript',
            body: `
        export class PiCourseError extends Error {}
        export async function previewFollowedCourse(){return {name:'Fictional A → Fictional B',pointCount:2,
          replacesDestination:true,pilotState:new URLSearchParams(location.search).has('engaged')?'engaged':'unknown',
          expiresAt:Date.now()+30000,current:()=>true,token:'b'.repeat(32),digest:'a'.repeat(64),routeKey:'fictional-a'};}
        export async function activateFollowedCourse(){window.__courseSends=(window.__courseSends||0)+1;}
        export async function clearSavedCourseReceipts(){return 1;}
    `,
        }),
    );
});
for (const width of [300, 375])
    test(`helm confirmation remains reachable at ${width}px and enlarged text`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 640 });
        const external: string[] = [];
        page.on('request', (request) => {
            if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:'))
                external.push(request.url());
        });
        await page.goto('/e2e/fixtures/course136.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const opener = page.getByRole('button', { name: 'Send followed route' });
        await opener.click();
        const dialog = page.getByRole('dialog', { name: 'Send followed route' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('Pilot state is not reported. Confirm standby at the helm.')).toBeVisible();
        const send = dialog.getByRole('button', { name: 'Send to plotter' });
        await expect(send).toBeDisabled();
        expect(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(false);
        await page.screenshot({ path: info.outputPath(`course-${width}-review.png`), animations: 'disabled' });
        await dialog.getByLabel(/I am at the helm/).check();
        await expect(send).toBeDisabled();
        await dialog.getByLabel(/Replace the boat/).check();
        await expect(send).toBeEnabled();
        await send.scrollIntoViewIfNeeded();
        const bounds = await send.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
        await page.screenshot({ path: info.outputPath(`course-${width}-controls.png`), animations: 'disabled' });
        await send.click();
        await expect(dialog.getByText(/Route confirmed on the boat/)).toBeVisible();
        await dialog.getByRole('button', { name: 'Done' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        expect(await page.evaluate(() => (window as unknown as { __courseSends: number }).__courseSends)).toBe(1);
        expect(external).toEqual([]);
    });
test('reported active pilot cannot be overridden; Escape closes and returns focus', async ({ page }) => {
    await page.goto('/e2e/fixtures/course136.html?engaged');
    const opener = page.getByRole('button', { name: 'Send followed route' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Send followed route' });
    await expect(dialog.getByText(/boat reports an active pilot/)).toBeVisible();
    await dialog.getByLabel(/I am at the helm/).check();
    await dialog.getByLabel(/Replace the boat/).check();
    await expect(dialog.getByRole('button', { name: 'Send to plotter' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
});
