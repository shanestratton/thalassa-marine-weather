import { expect, type Page } from '@playwright/test';

export type Palette = 'dark' | 'light' | 'night';

/** The night scrim's wash (App.tsx, and the fixtures that copy it). */
export const NIGHT_SCRIM = 'rgba(69, 10, 10, 0.25)';

/**
 * The palette a spec asked for is the one on screen (128-HUES review).
 * Daylight is the root's display-light class (App.tsx). Night is the dark
 * palette under the red scrim, so its computed colours are dark's and only the
 * scrim tells the two apart: a fixed wash over the whole screen. A seed that
 * silently missed would otherwise run a light or night case in the dark
 * palette, and it would pass.
 */
export async function expectPalette(page: Page, mode: Palette): Promise<void> {
    const drawn = () =>
        page.evaluate((wash) => {
            const scrims = [...document.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')].filter((element) => {
                const style = getComputedStyle(element);
                if (style.position !== 'fixed' || style.backgroundColor !== wash) return false;
                const box = element.getBoundingClientRect();
                return box.left <= 0 && box.top <= 0 && box.right >= innerWidth && box.bottom >= innerHeight;
            });
            return { light: document.documentElement.classList.contains('display-light'), scrims: scrims.length };
        }, NIGHT_SCRIM);
    await expect
        .poll(drawn, { message: `the ${mode} palette is on screen`, timeout: 5_000 })
        .toEqual({ light: mode === 'light', scrims: mode === 'night' ? 1 : 0 });
}
