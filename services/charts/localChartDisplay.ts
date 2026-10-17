import type mapboxgl from 'mapbox-gl';
import { readLocalChart, type LocalChartOperation } from './localChartLibrary';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { waitForLocalChart } from './localChartWait';
export interface LocalChartDisplay {
    readonly source: mapboxgl.RasterSourceSpecification | mapboxgl.ImageSourceSpecification;
    readonly bounds: [number, number, number, number] | null;
    readonly name: string;
    readonly note: string;
    isCurrent(): boolean;
    release(): void;
}
let queue: Promise<unknown> = Promise.resolve();
export function openLocalChartDisplay(id: string, options: LocalChartOperation): Promise<LocalChartDisplay> {
    const scope = getAuthIdentityScope();
    const current = () =>
        isAuthIdentityScopeCurrent(scope) && !options.signal?.aborted && options.isCurrent?.() !== false;
    const task = queue.then(() => openOne(id, { ...options, isCurrent: current }));
    queue = task.catch(() => undefined);
    return task;
}
async function openOne(id: string, options: LocalChartOperation): Promise<LocalChartDisplay> {
    const admitted = await readLocalChart(id, options);
    const check = () => {
        if (!admitted.isCurrent()) throw new Error('Local chart opening stopped.');
    };
    const deadline = performance.now() + 15_000;
    check();
    if (admitted.chart.kind !== 'mbtiles') {
        const { openLocalRasterChart } = await waitForLocalChart(import('./localRasterWorkerHost'), check, deadline);
        return openLocalRasterChart(admitted, options);
    }
    const { MBTilesService } = await waitForLocalChart(import('../MBTilesService'), check, deadline);
    check();
    const fileName = `retained-${admitted.namespace}-${id}.mbtiles`;
    const sourceCurrent = admitted.isCurrent;
    const opened = await MBTilesService.openRetained({
        fileName,
        name: admitted.chart.name,
        bytes: admitted.bytes,
        isCurrent: sourceCurrent,
    });
    if (!sourceCurrent()) {
        MBTilesService.closeRetained(fileName, sourceCurrent);
        throw new Error('Local chart opening stopped.');
    }
    return retainedDisplay(MBTilesService, fileName, sourceCurrent, admitted.chart.name, opened.metadata);
}
/** Separate closure scope: no admitted-file object or original bytes survives in the display lease. */
function retainedDisplay(
    service: Pick<typeof import('../MBTilesService').MBTilesService, 'closeRetained'>,
    fileName: string,
    sourceCurrent: () => boolean,
    name: string,
    metadata: import('../MBTilesService').MBTilesMetadata,
): LocalChartDisplay {
    return {
        source: {
            type: 'raster',
            tiles: [`http://mbtiles.local/${encodeURIComponent(fileName)}/{z}/{x}/{y}`],
            tileSize: 256,
            minzoom: metadata.minzoom ?? 0,
            maxzoom: metadata.maxzoom ?? 22,
            ...(metadata.bounds ? { bounds: metadata.bounds } : {}),
        },
        bounds: metadata.bounds ?? null,
        name,
        note: 'Private local MBTiles · own/open declaration only. Coverage, edition and depth datum are unverified. Display only; never used by routing or alarms.',
        isCurrent: sourceCurrent,
        release: () => service.closeRetained(fileName, sourceCurrent),
    };
}
