import { vi } from 'vitest';
import type { WindFieldMap } from '../../components/map/MapboxWindField';
import type { VelocityGribRecord } from '../../components/map/windVelocityFrame';

export function fieldRecords(u = 8, v = 4, west = -180, north = 80, dx = 10, dy = 10): VelocityGribRecord[] {
    return [u, v].map((speed, index) => ({
        header: {
            nx: 36,
            ny: 17,
            dx,
            dy,
            lo1: west,
            lo2: west + 350,
            la1: north,
            la2: -80,
            parameterCategory: 2,
            parameterNumber: index + 2,
            parameterNumberName: index ? 'V' : 'U',
        },
        data: Array(36 * 17).fill(speed),
    }));
}
export class InkContext {
    globalAlpha = 1;
    globalCompositeOperation = 'source-over';
    lineWidth = 1;
    fillStyle = '';
    strokeStyle = '';
    log: Array<{ kind: string; op: string; alpha: number; colour: string; width: number; point?: number[] }> = [];
    private record(kind: string, point?: number[]) {
        this.log.push({
            kind,
            op: this.globalCompositeOperation,
            alpha: this.globalAlpha,
            colour: kind === 'fill' ? this.fillStyle : this.strokeStyle,
            width: this.lineWidth,
            point,
        });
    }
    clearRect() {
        this.record('clear');
    }
    setTransform = vi.fn();
    fillRect() {
        this.record('fill');
    }
    beginPath() {
        this.record('begin');
    }
    moveTo(x: number, y: number) {
        this.record('move', [x, y]);
    }
    lineTo(x: number, y: number) {
        this.record('line', [x, y]);
    }
    stroke() {
        this.record('stroke');
    }
}
export function windFieldHarness(width = 128, height = 96, lng = 0, lat = 40, zoom = 5, bearing = 0) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const size = { width, height };
    const camera = { lng, lat, zoom, bearing };
    Object.defineProperties(container, {
        clientWidth: { get: () => size.width },
        clientHeight: { get: () => size.height },
    });
    const listeners = new Map<string, Set<() => void>>();
    const mercator = (lon: number, latitude: number) => ({
        x: (lon + 180) / 360,
        y: 0.5 - Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / (2 * Math.PI),
    });
    const map: WindFieldMap = {
        getContainer: () => container,
        getCenter: () => ({ lng: camera.lng, lat: camera.lat }),
        getZoom: () => camera.zoom,
        getBearing: () => camera.bearing,
        project: vi.fn(([lon, latitude]) => {
            const p = mercator(lon, latitude),
                c = mercator(camera.lng, camera.lat),
                world = 512 * 2 ** camera.zoom;
            const x = (p.x - c.x) * world,
                y = (p.y - c.y) * world,
                a = (-camera.bearing * Math.PI) / 180;
            return {
                x: size.width / 2 + x * Math.cos(a) - y * Math.sin(a),
                y: size.height / 2 + x * Math.sin(a) + y * Math.cos(a),
            };
        }),
        unproject: vi.fn(([x, y]) => {
            const c = mercator(camera.lng, camera.lat),
                a = (camera.bearing * Math.PI) / 180,
                world = 512 * 2 ** camera.zoom;
            const dx = x - size.width / 2,
                dy = y - size.height / 2;
            return {
                lng: (c.x + (dx * Math.cos(a) - dy * Math.sin(a)) / world) * 360 - 180,
                lat:
                    (Math.atan(Math.sinh(Math.PI * (1 - 2 * (c.y + (dx * Math.sin(a) + dy * Math.cos(a)) / world)))) *
                        180) /
                    Math.PI,
            };
        }),
        on(event, handler) {
            const set = listeners.get(event) ?? new Set();
            set.add(handler);
            listeners.set(event, set);
        },
        off(event, handler) {
            listeners.get(event)?.delete(handler);
        },
    };
    const callbacks = new Map<number, FrameRequestCallback>();
    let next = 0;
    const requestFrame = vi.fn((fn: FrameRequestCallback) => {
        const id = next++;
        callbacks.set(id, fn);
        return id;
    });
    const cancelFrame = vi.fn((id: number) => {
        callbacks.delete(id);
    });
    return {
        map,
        container,
        size,
        camera,
        listeners,
        callbacks,
        requestFrame,
        cancelFrame,
        emit(event: string) {
            for (const fn of [...(listeners.get(event) ?? [])]) fn();
        },
        step(time: number) {
            const frame = [...callbacks.values()];
            callbacks.clear();
            frame.forEach((fn) => fn(time));
        },
    };
}
