import type mapboxgl from 'mapbox-gl';
import { WindParticleLayer } from '../../components/map/WindParticleLayer';
import { decodeGribInWorker } from '../../services/weather/gribImportWorkerHost';
import type { ImportedGribFile } from '../../services/weather/gribImportTypes';
import { importedGribPressure } from '../../services/weather/importedGribPressure';
import { generateIsobarsFromGrid } from '../../services/weather/isobars';

Object.assign(window, {
    __gribImport: {
        async mapOverlay(file: ImportedGribFile) {
            const [{ default: mapbox }, { createRoot }, { createElement }, { MapboxVelocityOverlay }] =
                await Promise.all([
                    import('mapbox-gl'),
                    import('react-dom/client'),
                    import('react'),
                    import('../../components/map/MapboxVelocityOverlay'),
                ]);
            const container = document.createElement('div');
            container.style.cssText = 'width:256px;height:256px';
            document.body.append(container);
            const map = new mapbox.Map({
                container,
                accessToken: 'pk.fixture-only-synthetic-map',
                preserveDrawingBuffer: true,
                interactive: false,
                attributionControl: false,
                style: {
                    version: 8,
                    sources: {},
                    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#286432' } }],
                },
            });
            const errors: string[] = [];
            map.on('error', (event) => errors.push(String(event.error?.message)));
            const root = createRoot(container);
            try {
                await new Promise<void>((resolve, reject) => {
                    map.once('load', () => resolve());
                    setTimeout(() => reject(new Error('Map load deadline')), 10000);
                });
                const w = file.wind!;
                map.fitBounds(
                    [
                        [w.west, w.south],
                        [w.east, w.north],
                    ],
                    { padding: 24, duration: 0 },
                );
                root.render(
                    createElement(MapboxVelocityOverlay, {
                        mapboxMap: map,
                        visible: true,
                        particlesEnabled: false,
                        windGrid: w,
                        windHour: 0,
                    }),
                );
                const deadline = Date.now() + 10000;
                while (!map.getLayer('imported-grib-wind')) {
                    if (Date.now() > deadline) throw Error('Imported layer deadline');
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                await new Promise<void>((resolve) => {
                    let frames = 0;
                    const rendered = () => {
                        if (++frames === 3) {
                            map.off('render', rendered);
                            resolve();
                        }
                    };
                    map.on('render', rendered);
                    map.triggerRepaint();
                });
                const gl = map.getCanvas().getContext('webgl2')!,
                    canvas = map.getCanvas();
                const pixel = (lon: number) => {
                    const p = map.project([lon, (w.south + w.north) / 2]),
                        ratio = canvas.width / 256,
                        value = new Uint8Array(4);
                    gl.readPixels(
                        Math.round(p.x * ratio),
                        Math.round(canvas.height - p.y * ratio),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        value,
                    );
                    return [...value];
                };
                return {
                    known: pixel(w.west + (w.east - w.west) / 6),
                    unknown: pixel(w.west + ((w.east - w.west) * 5) / 6),
                    error: gl.getError(),
                    errors,
                };
            } finally {
                root.unmount();
                map.remove();
                container.remove();
            }
        },
        async decode(bytes: number[]) {
            let beats = 0;
            const heartbeat = setInterval(() => beats++, 0),
                buffer = new Uint8Array(bytes).buffer;
            try {
                const file = await decodeGribInWorker(buffer);
                return {
                    edition: file.edition,
                    wind: file.wind && {
                        width: file.wind.width,
                        height: file.wind.height,
                        hours: file.wind.stepHours,
                        first: [...file.wind.u[0].slice(0, 6)],
                    },
                    pressure: file.pressure && [...file.pressure.frames[0].slice(0, 6)],
                    transferred: buffer.byteLength === 0,
                    beats,
                };
            } finally {
                clearInterval(heartbeat);
            }
        },
        async cancel(bytes: number[]) {
            const abort = new AbortController(),
                pending = decodeGribInWorker(new Uint8Array(bytes).buffer, { signal: abort.signal });
            abort.abort();
            try {
                await pending;
                return 'accepted';
            } catch (error) {
                return (error as { code: string }).code;
            }
        },
        async render(file: ImportedGribFile) {
            const canvas = document.getElementById('wind') as HTMLCanvasElement,
                gl = canvas.getContext('webgl2', { alpha: true, preserveDrawingBuffer: true })!;
            const map = {
                getZoom: () => 5,
                isMoving: () => true,
                isZooming: () => false,
                isEasing: () => false,
                triggerRepaint: () => undefined,
            } as unknown as mapboxgl.Map;
            const layer = new WindParticleLayer();
            layer.onAdd(map, gl);
            layer.setGrid(file.wind!, 0);
            const w = file.wind!,
                x0 = (w.west + 180) / 360,
                x1 = (w.east + 180) / 360,
                merc = (lat: number) => 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI),
                y0 = merc(w.north),
                y1 = merc(w.south),
                sx = 1 / (x1 - x0),
                sy = -1 / (y1 - y0);
            const matrix = new Float32Array([
                sx,
                0,
                0,
                0,
                0,
                sy,
                0,
                0,
                0,
                0,
                1,
                0,
                -0.5 - sx * x0,
                0.5 - sy * y0,
                0,
                1,
            ]);
            const draw = (hour: number) => {
                layer.setForecastHour(hour);
                gl.viewport(0, 0, 128, 128);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                layer.render(gl, matrix);
                gl.finish();
                const pixel = (x: number) => {
                    const data = new Uint8Array(4);
                    gl.readPixels(x, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
                    return [...data];
                };
                return {
                    known: pixel(45),
                    boundary: pixel(55),
                    missing: pixel(84),
                    outside: pixel(8),
                    error: gl.getError(),
                };
            };
            try {
                const first = draw(0),
                    second = draw(1),
                    middle = draw(0.5),
                    pressure = importedGribPressure(file);
                let pressurePixels: number[][] = [];
                if (pressure) {
                    const image = generateIsobarsFromGrid(pressure, 0, false).heatmapDataUrl;
                    if (image) {
                        const decoded = new Image();
                        decoded.src = image;
                        await decoded.decode();
                        const c = document.createElement('canvas');
                        c.width = decoded.width;
                        c.height = decoded.height;
                        const ctx = c.getContext('2d')!;
                        ctx.drawImage(decoded, 0, 0);
                        pressurePixels = [...ctx.getImageData(0, 0, c.width, c.height).data].reduce<number[][]>(
                            (rows, v, i) => {
                                if (i % 4 === 0) rows.push([]);
                                rows.at(-1)!.push(v);
                                return rows;
                            },
                            [],
                        );
                    }
                }
                return { first, second, middle, pressurePixels };
            } finally {
                layer.onRemove(map, gl);
            }
        },
    },
});
