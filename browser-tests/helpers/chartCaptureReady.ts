import type { Page } from '@playwright/test';

/**
 * A paired pixel measurement needs a completed, still basemap frame, not just
 * visible controls. Request a real repaint and await Mapbox's own idle event
 * (tiles, camera and style transitions finished). Mapbox emits idle inside its
 * RAF render callback: resolving there need not mean that frame was presented.
 * Two genuine browser RAF callbacks allow an intervening rendering opportunity
 * before capture. This is not a GPU fence or a guarantee of presentation.
 * Never pause wind, add a wall-clock delay/retry, change paint or fake readiness.
 */
export async function waitForChartCaptureReady(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve, reject) => {
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
                map.once('idle', () => {
                    try {
                        requestAnimationFrame(() => {
                            try {
                                requestAnimationFrame(() => resolve());
                            } catch (error) {
                                reject(error);
                            }
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
                map.triggerRepaint();
            }),
    );
}
