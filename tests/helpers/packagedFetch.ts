import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

/**
 * A fetch that behaves like the phone in airplane mode: a same-origin path
 * ('/data/x.json') is answered from public/, which is packaged inside the app
 * (dist/ via Vite, then cap sync), and every other request fails the way
 * WebKit fails with no network. Missing packaged files are a 404.
 */
export function packagedFetch() {
    return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (!url.startsWith('/')) throw new TypeError('Load failed (no network)');
        const file = join(process.cwd(), 'public', url);
        if (!existsSync(file)) return new Response('', { status: 404 });
        return new Response(readFileSync(file), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
}
