import { HANDLE } from './validation.ts';

const EXACT_ORIGINS = new Set([
    'https://www.thalassawx.app',
    'https://thalassawx.app',
    'https://www.thalassawx.com',
    'https://thalassawx.com',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:4173',
    'http://localhost:4173',
]);

/** Boat public pages use one handle label on the two existing production domains. */
export function allowedDiaryCommentOrigin(origin: string): boolean {
    if (EXACT_ORIGINS.has(origin)) return true;
    try {
        const url = new URL(origin);
        // Origin headers have no path, credentials or non-default production port.
        if (url.protocol !== 'https:' || url.port || url.username || url.password || url.origin !== origin) {
            return false;
        }
        const labels = url.hostname.split('.');
        return labels.length === 3 && labels[1] === 'thalassawx' &&
            (labels[2] === 'app' || labels[2] === 'com') && labels[0].length <= 63 && HANDLE.test(labels[0]);
    } catch {
        return false;
    }
}
