import { readResponseJsonObjectLimited } from '../_shared/http-security.ts';

/** A deployment probe, never an attempted push. Neither missing half is ready. */
export async function underwayCapabilityReady(
    schemaVersion: () => Promise<unknown>,
    projectUrl: string | undefined,
    serviceKey: string | undefined,
    fetcher: typeof fetch = fetch,
): Promise<boolean> {
    if (!projectUrl || !serviceKey) return false;
    try {
        if (await schemaVersion() !== 1) return false;
        const base = new URL(projectUrl);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return false;
        const response = await fetcher(new URL('/functions/v1/send-push', base), {
            method: 'POST',
            headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'capabilities' }),
            signal: AbortSignal.timeout(3_000),
            redirect: 'error',
            cache: 'no-store',
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return false;
        }
        const body = await readResponseJsonObjectLimited(response, 1_024);
        return body?.underway_alarm === 1;
    } catch {
        return false;
    }
}
