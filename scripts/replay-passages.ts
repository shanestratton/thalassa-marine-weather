/** Run with: node node_modules/tsx/dist/cli.mjs scripts/replay-passages.ts INPUT OUTPUT
 * Both paths must be outside this checkout. No remote data is fetched. */
import { readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayLeg, type ReplayLeg } from '../services/routing/replayBenchmark';

const repository = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) throw new Error('Provide private input and report paths outside the checkout.');
const input = realpathSync(resolve(inputArg));
const output = resolve(realpathSync(dirname(resolve(outputArg))), resolve(outputArg).split(/[\\/]/).at(-1)!);
for (const path of [input, output]) {
    const child = relative(repository, path);
    if (!child || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)))
        throw new Error('Private replay paths must stay outside the source checkout.');
}
if (statSync(input).size > 64 * 1024 * 1024) throw new Error('Replay input exceeds 64 MiB.');
const data = JSON.parse(readFileSync(input, 'utf8')) as {
    schema: number;
    legs: ReplayLeg[];
    engineConfig?: { minWindSpeed?: number; motoringSpeed?: number };
};
if (data.schema !== 1 || !Array.isArray(data.legs) || !data.legs.length || data.legs.length > 100)
    throw new Error('Expected schema 1 and 1–100 private replay legs.');
const minWindSpeed = data.engineConfig?.minWindSpeed ?? 4;
const motoringSpeed = data.engineConfig?.motoringSpeed ?? 5;
if (
    !Number.isFinite(minWindSpeed) ||
    minWindSpeed < 0 ||
    minWindSpeed > 30 ||
    !Number.isFinite(motoringSpeed) ||
    motoringSpeed <= 0 ||
    motoringSpeed > 40
)
    throw new Error('Invalid vessel motoring settings.');
globalThis.fetch = async () => {
    throw new Error('Network access is disabled during offline replay.');
};
// The real unchanged production engine, with network bathymetry disabled.
// This is a weather/polar benchmark, not proof of chart clearance.
// Load through the installed Vite transformer, exactly as the app's tests
// do: transitive browser modules use import.meta.env and cannot run as raw
// Node imports. No HTTP server or browser is opened.
const { createServer } = await import('vite');
const transformer = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
});
try {
    const { computeIsochrones } = (await transformer.ssrLoadModule(
        '/services/IsochroneRouter.ts',
    )) as typeof import('../services/IsochroneRouter');
    const reports = [];
    for (const leg of data.legs)
        reports.push(
            await replayLeg(leg, async ({ origin, destination, departure, polar, wind }) => {
                const result = await computeIsochrones(origin, destination, departure, polar, wind, {
                    useDepthPenalty: false,
                    minWindSpeed,
                    motoringSpeed,
                });
                if (!result) return null;
                return {
                    route: result.route,
                    durationHours: result.totalDurationHours,
                    // Old snapshots have no propulsion tag: never infer from SOG.
                    motorHours:
                        'motorHours' in result && typeof result.motorHours === 'number' ? result.motorHours : null,
                };
            }),
        );
    writeFileSync(
        output,
        JSON.stringify(
            {
                schema: 1,
                createdAt: new Date().toISOString(),
                scope: 'Offline weather/polar replay; no navigation-clearance proof; no tuning performed',
                engineConfig: { minWindSpeed, motoringSpeed },
                reports,
            },
            null,
            2,
        ) + '\n',
        { flag: 'wx', mode: 0o600 },
    );
    console.log(`Saved ${reports.length} aggregate replay reports outside the source checkout.`);
} finally {
    await transformer.close();
}
// Browser services imported by the engine own polling timers. This isolated
// CLI has completed all synchronous writes and must not keep those running.
process.exit(0);
