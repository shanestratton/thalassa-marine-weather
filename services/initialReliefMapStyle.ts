import type { StyleSpecification } from 'mapbox-gl';
import { offlineReliefStyle } from '../components/map/reliefBase';
import { useUIStore } from '../stores/uiStore';
import { hydrateRelief, reliefStorage } from './OfflineReliefService';

/** Initial construction only. Boat Wi-Fi can be up while the WAN is down, so
 * saved terrain must not depend on an indefinitely pending remote style.
 * Resolve the same normal style in RAM, never an offline Mapbox download. */
export async function initialReliefMapStyle(
    style: string,
    token: string,
    signal: AbortSignal,
): Promise<string | StyleSpecification> {
    await hydrateRelief().catch(() => undefined);
    if (signal.aborted) throw new DOMException('Map startup cancelled', 'AbortError');
    if (navigator.onLine === false || useUIStore.getState().isOffline) return offlineReliefStyle();
    if (!reliefStorage().tiles) return style;
    const controller = new AbortController(),
        abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        const cancel = () => reject(new DOMException('Style unavailable', 'AbortError'));
        controller.signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(abort, 4000);
    });
    try {
        const url = style.startsWith('mapbox://styles/')
            ? `https://api.mapbox.com/styles/v1/${style.slice('mapbox://styles/'.length)}?access_token=${encodeURIComponent(token)}`
            : style;
        const read = (async () => {
            const response = await fetch(url, {
                signal: controller.signal,
                credentials: 'omit',
                redirect: 'error',
                cache: 'no-store',
            });
            if (
                !response.ok ||
                response.redirected ||
                !response.headers.get('content-type')?.includes('json') ||
                Number(response.headers.get('content-length')) > 1024 * 1024 ||
                !response.body
            )
                throw new Error('Style unavailable');
            const reader = response.body.getReader(),
                chunks: Uint8Array[] = [];
            let size = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > 1024 * 1024) {
                        await reader.cancel();
                        throw new Error('Style too large');
                    }
                    chunks.push(value);
                }
            } finally {
                reader.releaseLock();
            }
            const bytes = new Uint8Array(size);
            let at = 0;
            for (const c of chunks) {
                bytes.set(c, at);
                at += c.length;
            }
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            if (
                parsed?.version !== 8 ||
                !parsed.sources ||
                typeof parsed.sources !== 'object' ||
                !Array.isArray(parsed.layers)
            )
                throw new Error('Style unavailable');
            return parsed as StyleSpecification;
        })();
        return await Promise.race([read, deadline]);
    } catch (error) {
        if (signal.aborted) throw error;
        return offlineReliefStyle();
    } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
}
