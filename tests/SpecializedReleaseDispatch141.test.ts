import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertManifest, assetShardTag, DATASET_PROXY_SPECS, proxyReleaseAsset } from '../api/_releaseAssetProxy';
import {
    sshGeneration,
    SSH_BOUNDS,
    SSH_DATASET,
    SSH_FILE_BYTES,
    SSH_METADATA,
} from '../services/weather/api/sshManifestContract';

function observed() {
    const source = '2026-10-16T00:00:00Z';
    const hash = 'd'.repeat(64);
    const generation = sshGeneration(source, [hash]);
    return {
        schema_version: 2,
        dataset: { key: 'ssh', id: SSH_DATASET },
        generation,
        generated_at: '2026-10-17T00:00:00Z',
        published_at: '2026-10-17T00:01:00Z',
        data_start: source,
        data_end: source,
        cadence_hours: 24,
        dimensions: { width: 720, height: 360 },
        bounds: { ...SSH_BOUNDS },
        metadata: { ...SSH_METADATA },
        producer: { commit: 'a'.repeat(40), run_id: 123, run_attempt: 1 },
        files: [
            {
                step: 0,
                offset_hours: 0,
                data_time: source,
                filename: `${generation}-h000.bin`,
                bytes: SSH_FILE_BYTES,
                sha256: hash,
                content_type: 'application/octet-stream',
            },
        ],
    };
}
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('observed SSH uses the same specialized transport seam', () => {
    it('dispatches the independent observed contract and exact small asset cap', async () => {
        const source = observed();
        await expect(assertManifest(source, 'ssh')).resolves.toBe(source);
        await expect(assertManifest(source, 'sst')).rejects.toThrow();
        await expect(assertManifest(source, 'gfs-atmos')).rejects.toThrow();
        expect(DATASET_PROXY_SPECS.ssh.maxAssetBytes).toBe(4_406_464);
        expect(assetShardTag('ssh', source.generation)).toBe('cmems-ssh-latest-assets-2026-W42');
    });

    it('selects the original daily observation without retiming it into a forecast', async () => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-10-17T01:00:00Z');
        const fetch = vi.fn(
            async () => new Response(JSON.stringify(observed()), { headers: { 'content-type': 'application/json' } }),
        );
        vi.stubGlobal('fetch', fetch);
        const response = await proxyReleaseAsset(new Request('https://thalassa.test/api/ssh/manifest-v2.json'), 'ssh');
        expect(response.status).toBe(200);
        expect(response.headers.get('x-thalassa-valid-manifest-slots')).toBe('2');
        expect((await response.json()).data_start).toBe('2026-10-16T00:00:00Z');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('rechecks actual observed-source expiry after slot reads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-10-21T00:00:01Z');
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(JSON.stringify(observed()), { headers: { 'content-type': 'application/json' } }),
            ),
        );
        expect(
            (await proxyReleaseAsset(new Request('https://thalassa.test/api/ssh/manifest-v2.json'), 'ssh')).status,
        ).toBe(502);
    });

    it('never permits the original forecast legacy bridge for the new observed kind', async () => {
        vi.stubEnv('THALASSA_CMEMS_V1_BRIDGE_ENABLED', 'true');
        vi.useFakeTimers();
        vi.setSystemTime('2026-07-01T00:00:00Z');
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        for (const name of ['manifest.json', 'h00.bin']) {
            expect((await proxyReleaseAsset(new Request(`https://thalassa.test/api/ssh/${name}`), 'ssh')).status).toBe(
                410,
            );
        }
        expect(fetch).not.toHaveBeenCalled();
    });
});
