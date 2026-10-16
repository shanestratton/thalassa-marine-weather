import { test } from '../../../source/node_modules/@playwright/test';
import '../../../source/browser-tests/autorouting-trial.spec';

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const target = window as unknown as Record<string, any>;
        const rows: unknown[] = [];
        target.__trialStyleDiagnostics = rows;
        let control: any;
        Object.defineProperty(window, '__trialFixture', {
            configurable: true,
            get: () => control,
            set(next) {
                control = next;
                let map = control.map;
                Object.defineProperty(control, 'map', {
                    configurable: true,
                    get: () => map,
                    set(value) {
                        map = value;
                        if (!map || map.__trialDiagnosticWrapped) return;
                        map.__trialDiagnosticWrapped = true;
                        const original = map.isStyleLoaded;
                        const inspect = (loaded: boolean) => {
                            try {
                                const style = map.getStyle();
                                const layers = style?.layers ?? [];
                                const sources = Object.keys(style?.sources ?? {}).map((id) => {
                                    try { return { id, loaded: map.isSourceLoaded(id) }; }
                                    catch (error) { return { id, error: String(error).slice(0, 150) }; }
                                });
                                const graph = map.style;
                                const row = {
                                    at: performance.now(), loaded,
                                    enc: layers.findIndex((layer: any) => layer.id === 'enc-vec-depare-fill'),
                                    route: layers.findIndex((layer: any) => layer.id === 'trial-route'),
                                    layerIds: layers.map((layer: any) => layer.id),
                                    sourceStates: sources,
                                    graphLoaded: graph?._loaded,
                                    updatedSourceCaches: Object.keys(graph?._changes?.getUpdatedSourceCaches?.() ?? {}),
                                    imagesLoaded: graph?.imageManager?.isLoaded?.(),
                                    patternsInFlight: graph?.imageManager?.hasPatternsInFlight?.(),
                                    modelsLoaded: graph?.modelManager?.isLoaded?.(),
                                    mapErrors: [...(control.mapErrors ?? [])],
                                };
                                rows.push(row); if (rows.length > 300) rows.shift();
                            } catch (error) {
                                rows.push({ at: performance.now(), loaded, graphError: String(error).slice(0, 200) });
                            }
                        };
                        map.isStyleLoaded = function (...args: unknown[]) {
                            const loaded = original.apply(this, args);
                            inspect(loaded);
                            return loaded; // Exact original return and assertion are preserved.
                        };
                        target.__captureTrialStyle = () => inspect(original.call(map));
                    },
                });
            },
        });
    });
});
test.afterEach(async ({ page }, info) => {
    const state = await page.evaluate(() => {
        const target = window as unknown as Record<string, any>;
        target.__captureTrialStyle?.();
        return target.__trialStyleDiagnostics ?? [];
    }).catch((error) => [{ captureError: String(error) }]);
    await info.attach('trial-style-diagnostics', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
});
