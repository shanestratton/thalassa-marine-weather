import { readBoundedResponse } from './api/cmemsGridTrust';
import { SATELLITE_IMAGE_MAX } from './satelliteViewContract';

/** Race even an uncooperative decoder/fetch promise; late resources have explicit cleanup. */
export function awaitSatelliteOperation<T>(
    pending: Promise<T>,
    signal: AbortSignal,
    late?: (value: T) => void,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const abort = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            reject(signal.reason ?? new DOMException('Satellite read retired', 'AbortError'));
        };
        signal.addEventListener('abort', abort, { once: true });
        pending.then(
            (value) => {
                if (settled) {
                    late?.(value);
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', abort);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                reject(error);
            },
        );
        if (signal.aborted) abort();
    });
}

/** Fixed caller URLs only; this transport never follows redirects, sends credentials or stores a cache. */
export async function readSatelliteResponse(
    url: string,
    mime: 'xml' | 'application/json' | 'image/png',
    max: number,
    signal: AbortSignal,
): Promise<{ response: Response; bytes: Uint8Array }> {
    signal.throwIfAborted();
    const response = await awaitSatelliteOperation(
        fetch(url, {
            signal,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            headers: { Accept: mime === 'xml' ? 'application/xml,text/xml' : mime },
        }),
        signal,
        (response) => {
            void response.body?.cancel().catch(() => undefined);
        },
    );
    const actual = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (
        response.status !== 200 ||
        (mime === 'xml' ? !['application/xml', 'text/xml'].includes(actual ?? '') : actual !== mime)
    ) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Satellite response refused');
    }
    const bytes = await readBoundedResponse(response, max, signal);
    signal.throwIfAborted();
    return { response, bytes };
}
export function validateSatellitePng(bytes: Uint8Array, width: number, height: number): void {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
    if (
        bytes.byteLength < 33 ||
        bytes.byteLength > SATELLITE_IMAGE_MAX ||
        !signature.every((value, index) => bytes[index] === value)
    )
        throw new Error('Satellite PNG signature refused');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
        width < 1 ||
        height < 1 ||
        width > 1024 ||
        height > 1024 ||
        view.getUint32(16) !== width ||
        view.getUint32(20) !== height
    )
        throw new Error('Satellite PNG dimensions refused');
}
