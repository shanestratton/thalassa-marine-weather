import { expect, test, type Page } from '@playwright/test';
import { DIARY_DEVICES, type DiaryDevice } from '../e2e/fixtures/diary-compose-devices';

/**
 * The weather bubble with the sea in parts (build 130, 130-04): three
 * partition rows with their arrows, the wave power and the beta comfort word,
 * the "models differ" line and the MFWAM (and NOAA) credit, in the real
 * WeatherInspectPopup with the app's CSS (e2e/fixtures/weather-inspect.tsx),
 * fed the trimmed real replies in tests/fixtures/sea-partitions.
 *
 * The bubble cannot scroll. Drawn as Mapbox draws it, anchored under a tap at
 * the top of the screen's band, the Save row must end above the tab bar on
 * the smallest phone (320 x 568) in wide fonts (Verdana on a Mac, DejaVu Sans
 * on the Linux runner), with the longest lines it carries: the nearest-buoy
 * line, the models' disagreement, an imperial skipper's own boat. Nothing
 * sideways; each partition row on one line; no word under the 12 px floor,
 * and no line pitch under 1.25 × its font (`leading-4` is 1rem, 13 px under
 * a 12 px font at the app's own 13 px root, which the house 16 px root hides:
 * so the 320 px phone also runs at the app's root, ?root=app).
 *
 * The first paint, too (?pending=1): the atmospherics in, the sea still in
 * the air. Mapbox picks the bubble's anchor from that paint and never again,
 * so the sea's arrival must swap content, not grow the bubble.
 *
 * env() is 0 under Playwright, so the fixture paints each device's insets.
 */

const SCENES = [
    // MFWAM 0.82 m against GFS Wave 1.3 m: the disagreement line and NOAA's credit, plus a buoy.
    { scenario: 'gulf', now: '2026-10-14T03:30:00Z', units: 'metric', vessel: 'none', buoy: '1', rows: true },
    // Feet, a 34 ft sloop's estimated waterline, and a buoy.
    { scenario: 'northsea', now: '2026-10-14T06:30:00Z', units: 'imperial', vessel: 'sloop', buoy: '1', rows: true },
    // A Caribbean cross sea, a catamaran.
    { scenario: 'anegada', now: '2026-10-19T05:30:00Z', units: 'metric', vessel: 'cat', buoy: '0', rows: true },
    // Inside the reef: parts read "none", and the models differ.
    { scenario: 'whitsundays', now: '2026-10-14T06:30:00Z', units: 'imperial', vessel: 'none', buoy: '1', rows: true },
    // A lake MFWAM models, 181 m up: feet and a sloop.
    { scenario: 'superior', now: '2026-10-14T06:30:00Z', units: 'imperial', vessel: 'sloop', buoy: '0', rows: true },
    // A berth: no number from a cell 17.7 km out.
    { scenario: 'airlie', now: '2026-10-14T06:30:00Z', units: 'metric', vessel: 'none', buoy: '1', rows: false },
] as const;

const DEVICES: DiaryDevice[] = [DIARY_DEVICES['iphone-se-zoomed'], DIARY_DEVICES['iphone-14']];

type Scene = (typeof SCENES)[number];

async function open(page: Page, device: DiaryDevice, scene: Scene, extra: Record<string, string> = {}) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.unroute('**/*');
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.clock.setFixedTime(new Date(scene.now));
    await page.setViewportSize({ width: device.width, height: device.height });
    const params = new URLSearchParams({
        scenario: scene.scenario,
        units: scene.units,
        vessel: scene.vessel,
        buoy: scene.buoy,
        fonts: 'wide',
        top: String(device.top),
        bottom: String(device.bottom),
        ...extra,
    });
    await page.goto(`/e2e/fixtures/weather-inspect.html?${params}`);
    const bubble = page.getByTestId('inspect-bubble');
    await expect(bubble.getByRole('button', { name: /Save this spot/ })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return { errors, bubble };
}

function layoutIssues(page: Page) {
    return page.evaluate(() => {
        const issues: string[] = [];
        const W = window.innerWidth;
        const bubble = document.querySelector<HTMLElement>('[data-testid="inspect-bubble"]')!;
        const box = bubble.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const save = [...bubble.querySelectorAll('button')].find((b) => /Save this spot/.test(b.textContent ?? ''))!;
        const s = save.getBoundingClientRect();
        if (s.bottom > nav.top + 0.5)
            issues.push(`the Save row ends ${(s.bottom - nav.top).toFixed(1)} px under the tab bar`);
        if (box.top < 0) issues.push('the bubble starts above the screen');
        if (box.left < -0.5 || box.right > W + 0.5) issues.push('the bubble runs off the side');
        if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
        for (const el of bubble.querySelectorAll<HTMLElement>('p, td, th, span, button')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || el.closest('.sr-only')) continue;
            if (r.left < box.left - 0.5 || r.right > box.right + 0.5)
                issues.push(`"${el.textContent?.trim().slice(0, 24)}" escapes the bubble`);
        }
        // Each partition row stays one line: label, height, period, arrow.
        for (const row of bubble.querySelectorAll<HTMLElement>('table tr')) {
            const cells = [...row.children] as HTMLElement[];
            const tops = cells.map((c) => c.getBoundingClientRect().height);
            if (Math.max(...tops) > 24) issues.push(`row "${row.textContent?.trim()}" wraps (${Math.max(...tops)} px)`);
        }
        for (const element of bubble.querySelectorAll<Element>('*')) {
            const words = [...element.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
            if (!words || element.closest('.sr-only')) continue;
            const style = getComputedStyle(element);
            const size = parseFloat(style.fontSize);
            if (size < 12)
                issues.push(`"${element.textContent?.trim().slice(0, 24)}" is ${size}px, under the 12 px floor`);
            // Lines that stack need room between them: the partition rows, and
            // every paragraph that wraps (the comfort word, models differ, the
            // credit). A one-line label set tight (leading-none) stacks on nothing.
            const pitch = parseFloat(style.lineHeight);
            const range = document.createRange();
            range.selectNodeContents(element);
            const tops = new Set(
                [...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)),
            );
            const stacks = element.matches('td, th') || (element.matches('p') && tops.size > 1);
            if (stacks && Number.isFinite(pitch) && pitch < 1.25 * size - 0.01)
                issues.push(
                    `"${element.textContent?.trim().slice(0, 24)}" has ${pitch}px lines under a ${size}px font`,
                );
        }
        return issues;
    });
}

for (const device of DEVICES) {
    for (const scene of SCENES) {
        test(`the bubble fits ${device.name} (${device.width}x${device.height}), wide fonts: ${scene.scenario} in ${scene.units}`, async ({
            page,
        }, info) => {
            const { errors, bubble } = await open(page, device, scene);
            const font = await bubble.evaluate((el) => getComputedStyle(el.querySelector('p')!).fontFamily);
            expect(font, 'the house wide-font rule').toMatch(/^(Verdana|"DejaVu Sans"|DejaVu Sans)/);
            if (scene.rows) {
                const table = bubble.getByRole('table', { name: 'Waves in parts' });
                await expect(table.getByRole('row')).toHaveCount(3);
                for (const label of ['Wind sea', 'Swell', 'Swell 2'])
                    await expect(table.getByRole('rowheader', { name: label, exact: true })).toBeVisible();
                await expect(bubble.getByTestId('sea-comfort')).toContainText('(beta)');
                await expect(bubble.getByTestId('sea-comfort')).toContainText('comfort, not safety');
                await expect(bubble.getByTestId('inspect-credit')).toContainText('Météo-France MFWAM');
            } else {
                await expect(bubble.getByText('No open-water wave model reaches here')).toBeVisible();
                await expect(bubble).not.toContainText('over land');
            }
            if (scene.scenario === 'gulf') {
                await expect(bubble.getByText('Wave models differ: MFWAM 0.8 m, GFS Wave (NOAA) 1.3 m')).toBeVisible();
                // An arrow per part, each its own.
                await expect(bubble.locator('table [data-sea-arrow]')).toHaveCount(3);
            }
            expect(await layoutIssues(page)).toEqual([]);
            expect(errors).toEqual([]);
            if (device.width === 320) {
                const shot = info.outputPath(`weather-inspect-${scene.scenario}-320.png`);
                await page.screenshot({ path: shot });
                await info.attach(`weather-inspect-${scene.scenario}-320`, { path: shot, contentType: 'image/png' });
            }
        });
    }
}

// The app's own fluid root on the smallest phone: 13 px, where rem-sized lines shrink.
for (const scene of SCENES) {
    const device = DIARY_DEVICES['iphone-se-zoomed'];
    test(`the bubble fits ${device.name} at the app's own 13 px root: ${scene.scenario}`, async ({ page }) => {
        const { errors, bubble } = await open(page, device, scene, { root: 'app' });
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('13px');
        if (scene.rows) await expect(bubble.getByTestId('inspect-credit')).toContainText('Météo-France MFWAM');
        expect(await layoutIssues(page)).toEqual([]);
        expect(errors).toEqual([]);
    });
}

for (const device of DEVICES) {
    for (const scene of SCENES.filter((s) => s.rows)) {
        test(`the sea's arrival swaps content, it does not grow the bubble: ${device.name}, ${scene.scenario}`, async ({
            page,
        }) => {
            const first = await open(page, device, scene, { pending: '1' });
            await expect(first.bubble.getByTestId('sea-pending')).toContainText('Sea state loading');
            // The three rows hold their place, reading "--"; the credit is already on the footer.
            await expect(first.bubble.getByRole('table', { name: 'Waves in parts' }).getByRole('row')).toHaveCount(3);
            await expect(first.bubble.getByTestId('inspect-credit')).toContainText('Météo-France MFWAM');
            expect(await layoutIssues(page), 'the first paint fits').toEqual([]);
            const before = (await first.bubble.boundingBox())!.height;

            const done = await open(page, device, scene);
            await expect(done.bubble.getByTestId('sea-comfort')).toBeVisible();
            const after = (await done.bubble.boundingBox())!.height;
            // New on arrival: the "models differ" line where it shows, and at most
            // one line more where the comfort word runs to a fourth (her own
            // waterline named). The old one-line loading box grew by ~115 px here.
            const differ = done.bubble.getByText(/^Wave models differ/);
            const differHeight = (await differ.count()) ? (await differ.boundingBox())!.height + 2 : 0;
            expect(after - before, `grew ${(after - before).toFixed(1)} px (${before} → ${after})`).toBeLessThanOrEqual(
                differHeight + 16 + 4,
            );
            expect([...first.errors, ...done.errors]).toEqual([]);
        });
    }
}
