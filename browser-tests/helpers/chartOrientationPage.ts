import { expect, type Page } from '@playwright/test';

/**
 * e2e/fixtures/chart-orientation.tsx, opened offline at 390 × 844, for
 * chart-orientation.spec.ts and chart-orientation-sideways.spec.ts. Returns the
 * page errors seen from then on.
 */
export async function openOrientation(page: Page, query: Record<string, string>) {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const local = url.protocol === 'blob:' || ['127.0.0.1', 'localhost'].includes(url.hostname);
        return local ? route.continue() : route.abort();
    });
    await page.goto(`/e2e/fixtures/chart-orientation.html?${new URLSearchParams(query)}`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    return errors;
}

export type Pt = { x: number; y: number };
export interface WindRead {
    probes: Array<{ mapbox: Pt; css: Pt }>;
    div: { inset: string; width: string; height: string; transform: string };
    view: { width: number; height: number };
}
export const windProbes = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as { __orient: { windProbes: () => Promise<WindRead> } }).__orient.windProbes(),
    );
