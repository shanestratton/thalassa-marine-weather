import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The page a phone WITHOUT Thalassa gets when it is held to a box tag (126-11b):
 * public/box.html, which vercel.json serves for https://www.thalassawx.app/box/<id>.
 *
 * It says what the tag is and nothing about the box: no contents, no boat, no
 * id. It runs no script and loads nothing but itself (its icon is inline), so
 * it costs a stranger's phone one small request, in any country, on any signal.
 * It fits a 320 x 568 phone and a 430 x 932 one, light and dark, with no
 * sideways scroll.
 *
 * Set BOX_PAGE_SHOTS_DIR to save the screenshots for Shane.
 */
const SHOTS = process.env.BOX_PAGE_SHOTS_DIR?.trim() || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const SIZES = [
    { width: 320, height: 568 },
    { width: 430, height: 932 },
] as const;

for (const size of SIZES) {
    for (const colorScheme of ['light', 'dark'] as const) {
        test(`box tag page fits ${size.width}x${size.height} (${colorScheme}) and loads only itself`, async ({
            page,
            baseURL,
        }) => {
            await page.setViewportSize(size);
            await page.emulateMedia({ colorScheme });
            const requests: string[] = [];
            page.on('request', (request) => requests.push(request.url()));

            await page.goto('/box.html', { waitUntil: 'networkidle' });

            expect(requests).toEqual([`${baseURL}/box.html`]);
            await expect(page.locator('script')).toHaveCount(0);
            await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
            await expect(
                page.getByText('This tag belongs to a stowage box on a boat that uses Thalassa.'),
            ).toBeVisible();

            const layout = await page.evaluate(() => ({
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
                background: getComputedStyle(document.body).backgroundColor,
                text: getComputedStyle(document.body).color,
                main: document.querySelector('main')?.getBoundingClientRect().toJSON(),
            }));
            expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
            // The card sits inside the screen with the 16 px gutter.
            expect(layout.main.left).toBeGreaterThanOrEqual(16);
            expect(layout.main.right).toBeLessThanOrEqual(size.width - 16);
            expect(layout.main.bottom).toBeLessThanOrEqual(size.height);
            // The theme follows the phone: a dark page in dark mode, a light one in light.
            const luminance = (rgb: string) => {
                const [r, g, b] = (rgb.match(/\d+/g) ?? ['0', '0', '0']).map(Number);
                return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            };
            if (colorScheme === 'dark') expect(luminance(layout.background)).toBeLessThan(60);
            else expect(luminance(layout.background)).toBeGreaterThan(200);
            expect(Math.abs(luminance(layout.background) - luminance(layout.text))).toBeGreaterThan(120);

            if (SHOTS) {
                await page.screenshot({
                    path: join(
                        SHOTS,
                        `box-${size.width}x${size.height}-${colorScheme}-${test.info().project.name}.png`,
                    ),
                    fullPage: true,
                });
            }
        });
    }
}
