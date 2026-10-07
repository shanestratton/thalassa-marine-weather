import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The house fit rule's wide fonts for layout specs (fit123). The Linux CI
 * runner draws the app's sans face as DejaVu Sans, far wider than a Mac's, so a
 * fit spec lays out in Verdana on a Mac and DejaVu Sans there: the same wraps
 * on both.
 */
export const WIDE_FONT_STACK = "Verdana, 'DejaVu Sans', sans-serif";

/** For a fixture without its own ?fonts=wide: the app's sans face swapped before the page draws. */
export async function applyWideFonts(page: Page): Promise<void> {
    await page.addInitScript((stack) => {
        document.addEventListener('DOMContentLoaded', () => {
            const wide = document.createElement('style');
            wide.textContent = `:root { --font-sans: ${stack} !important; }`;
            document.head.append(wide);
        });
    }, WIDE_FONT_STACK);
}

/**
 * The wide face is the one drawn, not just the one asked for. The target's own
 * font, measured on a canvas, must match Verdana or DejaVu Sans, and that face
 * must be installed: a missing face falls back to monospace and measures as
 * monospace. A runner image with neither would otherwise lay the fit cells out
 * in a narrower fallback and pass them without the case they guard.
 */
export async function expectWideFaceDrawn(target: Locator): Promise<void> {
    const m = await target.evaluate((element) => {
        const style = getComputedStyle(element);
        const context = document.createElement('canvas').getContext('2d')!;
        const width = (family: string) => {
            context.font = `${style.fontStyle} ${style.fontWeight} 40px ${family}`;
            return context.measureText('Her wind vs the models, 0123456789 WMmil').width;
        };
        return {
            family: style.fontFamily,
            own: width(style.fontFamily),
            monospace: width('monospace'),
            verdana: width('Verdana, monospace'),
            dejaVu: width('"DejaVu Sans", monospace'),
        };
    });
    expect(m.family, 'the house wide-font stack').toMatch(/^(Verdana|"DejaVu Sans"|DejaVu Sans)/);
    const installed = [m.verdana, m.dejaVu].filter((width) => Math.abs(width - m.monospace) > 0.5);
    expect(
        installed.some((width) => Math.abs(width - m.own) < 0.5),
        `a wide face drawn: ${JSON.stringify(m)}`,
    ).toBe(true);
}
