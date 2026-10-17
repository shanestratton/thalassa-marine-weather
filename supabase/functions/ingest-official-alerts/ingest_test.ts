/**
 * ingest-official-alerts on Deno (129-05): the edge runtime's own fetch types,
 * crypto and timers. A re-ingest of the same NWS answer writes nothing and does
 * not call the database; a provider whose licence flag is off is never fetched.
 * The full suite is tests/OfficialAlertsIngest.test.ts (vitest).
 */
import type { Known, ProviderRow } from '../_shared/official-alerts/adapters.ts';
import { type AlertStore, type ChangeSet, createHttp, runIngest } from '../_shared/official-alerts/ingest.ts';

function assertEquals(actual: unknown, expected: unknown): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const NWS = 'https://api.weather.gov/alerts/active?status=actual';
const OFF = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france';
const BODY = JSON.stringify({
    type: 'FeatureCollection',
    features: [{
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [[[-76.5, 38.3], [-76.2, 38.3], [-76.2, 38.6], [-76.5, 38.6], [-76.5, 38.3]]],
        },
        properties: {
            id: 'urn:oid:2.49.0.1.840.0.zzdeno.001.1',
            sender: 'w-nws.webmaster@noaa.gov',
            sent: '2026-10-13T15:05:00-04:00',
            status: 'Actual',
            messageType: 'Alert',
            event: 'Special Marine Warning',
            severity: 'Moderate',
            urgency: 'Immediate',
            certainty: 'Observed',
            expires: '2026-10-13T16:00:00-04:00',
            description: 'A fictional thunderstorm, for the Deno test only.',
            references: [],
            affectedZones: [],
        },
    }],
});

const row = (over: Partial<ProviderRow>): ProviderRow => ({
    id: 'nws',
    adapter: 'nws',
    name: 'NWS',
    feedUrl: NWS,
    enabled: true,
    config: {},
    feedState: {},
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    unavailableSince: null,
    ...over,
});

Deno.test('a re-ingest of the same feed writes nothing, and an OFF provider is never fetched', async () => {
    const providers = [
        row({}),
        row({ id: 'meteoalarm-fr', adapter: 'meteoalarm', feedUrl: OFF, enabled: false }),
    ];
    const hashes = new Map<string, Known>();
    let applies = 0;
    const store: AlertStore = {
        providers: () => Promise.resolve(providers.map((p) => ({ ...p }))),
        known: () => Promise.resolve(new Map(hashes)),
        missingZones: (_p, keys) => Promise.resolve(keys),
        apply(providerId: string, change: ChangeSet) {
            applies++;
            for (const a of change.upserts) {
                hashes.set(a.identifier, { hash: a.contentHash, live: true, expiresAt: a.expiresAt });
            }
            if (change.status) Object.assign(providers.find((p) => p.id === providerId)!, change.status);
            return Promise.resolve();
        },
    };
    const fetched: string[] = [];
    const fetchImpl = ((url: string) => {
        fetched.push(url);
        return Promise.resolve(new Response(url === NWS ? BODY : 'no', { status: url === NWS ? 200 : 404 }));
    }) as unknown as typeof fetch;
    const http = createHttp(fetchImpl, { userAgent: 'Thalassa Deno test' });
    const t0 = Date.parse('2026-10-13T19:10:00Z');

    const first = await runIngest({ store, http, nowMs: t0 });
    assertEquals(first.ran.map((r) => [r.provider, r.ok, r.upserts]), [['nws', true, 1]]);
    assertEquals(first.off, ['meteoalarm-fr']);
    assertEquals(applies, 1);

    const second = await runIngest({ store, http, nowMs: t0 + 5 * 60_000 });
    assertEquals(second.ran.map((r) => r.writes), [0]);
    assertEquals(applies, 1);
    assertEquals(fetched.includes(OFF), false);
});
