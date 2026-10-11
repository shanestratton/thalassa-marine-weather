import type { Page } from '@playwright/test';

/**
 * A paired pixel measurement needs a completed, still basemap frame, not just
 * visible controls. Request a real repaint and await Mapbox's own idle event
 * (tiles, camera and style transitions finished). Never pause the wind, retry
 * a capture, change a paint value or manufacture a readiness flag.
 */
export async function waitForChartCaptureReady(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                const map = (
                    window as unknown as {
                        __thalassaMap?: {
                            once(event: string, callback: () => void): void;
                            triggerRepaint(): void;
                        };
                    }
                ).__thalassaMap;
                if (!map || typeof map.once !== 'function' || typeof map.triggerRepaint !== 'function') {
                    throw new Error('A real chart is required before paired pixel measurement');
                }
                map.once('idle', () => resolve());
                map.triggerRepaint();
            }),
    );
}
