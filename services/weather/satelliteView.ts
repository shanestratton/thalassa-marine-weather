import { API_BASE } from '../native/apiBase';
import { satelliteModeBlocks } from '../networkPolicy';
import { awaitSatelliteOperation, readSatelliteResponse, validateSatellitePng } from './satelliteViewBytes';
import {
    SATELLITE_IMAGE_MAX,
    SATELLITE_METADATA_LIFETIME_MS,
    SATELLITE_METADATA_MAX,
    validateSatelliteViewTimes,
    type SatelliteViewBox,
    type SatelliteViewFrame,
    type SatelliteViewProduct,
    type SatelliteViewTimes,
} from './satelliteViewContract';
import type { OwnedImageFrame } from '../../components/map/useOwnedImageOverlay';

export interface SatelliteImagePart {
    readonly box: SatelliteViewBox;
    readonly width: number;
    readonly left: number;
}
export interface SatelliteImagePlan {
    readonly key: string;
    readonly width: number;
    readonly height: number;
    readonly box: SatelliteViewBox;
    readonly parts: readonly SatelliteImagePart[];
}
export interface SatelliteTimesLease {
    readonly times: SatelliteViewTimes;
    isCurrent(): boolean;
    close(): void;
}
export interface PreparedSatelliteFrame {
    readonly product: SatelliteViewProduct;
    readonly frame: SatelliteViewFrame;
    readonly plan: SatelliteImagePlan;
    readonly metadataUrl: string;
    readonly metadataReadAtMs: number;
    readonly alphaFraction: number;
    isCurrent(): boolean;
    claim(): OwnedImageFrame;
    releaseUnclaimed(): void;
}
const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const ownedPlans = new WeakSet<SatelliteImagePlan>();
/** One Mercator viewport image, split into at most two sequential requests at the dateline. */
export function satelliteImagePlan(bounds: readonly number[]): SatelliteImagePlan {
    if (
        !Array.isArray(bounds) ||
        bounds.length !== 4 ||
        !bounds.every(Number.isFinite) ||
        bounds[2] <= bounds[0] ||
        bounds[2] - bounds[0] > 360 ||
        bounds[3] <= bounds[1] ||
        bounds[3] <= -85 ||
        bounds[1] >= 85
    )
        throw Error('Satellite viewport unknown');
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    const span = bounds[2] - bounds[0],
        west = round(((((bounds[0] + 180) % 360) + 360) % 360) - 180),
        east = round(west + span),
        south = round(Math.max(-85, bounds[1])),
        north = round(Math.min(85, bounds[3]));
    const ratio = (span * Math.PI) / 180 / (mercatorY(north) - mercatorY(south));
    const width = Math.max(2, ratio >= 1 ? 1024 : Math.round(1024 * ratio)),
        height = Math.max(1, ratio >= 1 ? Math.round(1024 / ratio) : 1024);
    if (!Number.isFinite(ratio) || ratio <= 0 || width > 1024 || height > 1024 || east <= west || north <= south)
        throw Error('Satellite viewport scale invalid');
    const parts: SatelliteImagePart[] = [];
    if (east <= 180)
        parts.push(
            Object.freeze({ box: Object.freeze([west, south, east, north]) as SatelliteViewBox, width, left: 0 }),
        );
    else {
        const first = Math.max(1, Math.min(width - 1, Math.round((width * (180 - west)) / span)));
        parts.push(
            Object.freeze({ box: Object.freeze([west, south, 180, north]) as SatelliteViewBox, width: first, left: 0 }),
            Object.freeze({
                box: Object.freeze([-180, south, round(east - 360), north]) as SatelliteViewBox,
                width: width - first,
                left: first,
            }),
        );
    }
    const box = Object.freeze([west, south, east, north]) as SatelliteViewBox;
    const plan = Object.freeze({
        key: `${box.join(',')}:${width}x${height}`,
        width,
        height,
        box,
        parts: Object.freeze(parts),
    });
    ownedPlans.add(plan);
    return plan;
}
export function satelliteProductAt(bounds: readonly number[]): SatelliteViewProduct {
    if (bounds.length !== 4 || !bounds.every(Number.isFinite)) throw Error('Satellite position unknown');
    const latitude = (bounds[1] + bounds[3]) / 2,
        longitude = (((((bounds[0] + bounds[2]) / 2 + 180) % 360) + 360) % 360) - 180;
    return Math.abs(latitude) > 60
        ? 'viirs-night'
        : longitude >= 60 || longitude < -160
          ? 'himawari-ir'
          : longitude < -105
            ? 'goes-west-ir'
            : longitude < -30
              ? 'goes-east-ir'
              : 'meteosat-ir';
}
const checkNetwork = () => {
    if (satelliteModeBlocks('raster')) throw Error('Satellite Mode blocks this imagery');
};
function deadline(signal: AbortSignal) {
    const controller = new AbortController(),
        abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(Error('Satellite preparation deadline')), 25000);
    return {
        signal: controller.signal,
        finish: () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        },
    };
}
export async function readSatelliteTimes(
    product: SatelliteViewProduct,
    signal: AbortSignal,
    ownerCurrent: () => boolean,
): Promise<SatelliteTimesLease> {
    const wall = Date.now(),
        mono = performance.now(),
        bounded = deadline(signal);
    let closed = false;
    const current = () => {
        try {
            return (
                !closed &&
                !signal.aborted &&
                ownerCurrent() &&
                !satelliteModeBlocks('raster') &&
                Date.now() >= wall - 2000 &&
                Date.now() - wall <= SATELLITE_METADATA_LIFETIME_MS &&
                performance.now() >= mono &&
                performance.now() - mono <= SATELLITE_METADATA_LIFETIME_MS
            );
        } catch {
            return false;
        }
    };
    try {
        checkNetwork();
        if (!current()) throw Error('Satellite metadata owner retired');
        const { bytes } = await readSatelliteResponse(
            `${API_BASE}/satellite-view?action=times&product=${product}`,
            'application/json',
            SATELLITE_METADATA_MAX,
            bounded.signal,
        );
        const candidate = validateSatelliteViewTimes(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
            product,
            Date.now(),
        );
        if (!current()) throw Error('Satellite metadata owner retired');
        const times = Object.freeze({
            ...candidate,
            frames: Object.freeze(candidate.frames.map((frame) => Object.freeze({ ...frame }))),
        });
        return {
            times,
            isCurrent: () =>
                current() &&
                Date.now() - times.readAtMs <= SATELLITE_METADATA_LIFETIME_MS &&
                Date.now() >= times.readAtMs - 60000,
            close: () => {
                closed = true;
            },
        };
    } finally {
        bounded.finish();
    }
}
function imageOwner(
    product: SatelliteViewProduct,
    frame: SatelliteViewFrame,
    plan: SatelliteImagePlan,
    times: SatelliteViewTimes,
    alphaFraction: number,
    url: string,
    current: () => boolean,
): PreparedSatelliteFrame {
    let released = false,
        claimed = false;
    const isCurrent = () => !released && current();
    const release = () => {
        if (released) return;
        released = true;
        URL.revokeObjectURL(url);
    };
    const [west, south, east, north] = plan.box;
    const image: OwnedImageFrame = {
        url,
        width: plan.width,
        height: plan.height,
        coordinates: [
            [west, north],
            [east, north],
            [east, south],
            [west, south],
        ],
        release,
    };
    return {
        product,
        frame,
        plan,
        metadataUrl: times.metadataUrl,
        metadataReadAtMs: times.readAtMs,
        alphaFraction,
        isCurrent,
        claim: () => {
            if (!isCurrent()) throw Error('Satellite image owner retired');
            claimed = true;
            return image;
        },
        releaseUnclaimed: () => {
            if (!claimed) release();
        },
    };
}
/** Original palettes only. One canvas; one encoded provider part/bitmap at a time; no frame/history cache. */
export async function prepareSatelliteFrame(
    lease: SatelliteTimesLease,
    frame: SatelliteViewFrame,
    plan: SatelliteImagePlan,
    signal: AbortSignal,
    ownerCurrent: () => boolean,
): Promise<PreparedSatelliteFrame> {
    const bounded = deadline(signal),
        product = lease.times.product;
    const current = () => {
        try {
            return !signal.aborted && lease.isCurrent() && ownerCurrent() && !satelliteModeBlocks('raster');
        } catch {
            return false;
        }
    };
    const check = () => {
        bounded.signal.throwIfAborted();
        if (!current()) throw Error('Satellite image source retired');
    };
    try {
        checkNetwork();
        check();
        if (
            !ownedPlans.has(plan) ||
            !lease.times.frames.includes(frame) ||
            plan.parts.length < 1 ||
            plan.parts.length > 2 ||
            plan.width > 1024 ||
            plan.height > 1024
        )
            throw Error('Satellite image selection invalid');
        const canvas = document.createElement('canvas');
        canvas.width = plan.width;
        canvas.height = plan.height;
        const context = canvas.getContext('2d');
        if (!context) throw Error('Satellite canvas unavailable');
        context.globalAlpha = 0.72;
        for (const part of plan.parts) {
            check();
            const params = new URLSearchParams({
                action: 'image',
                product,
                time: frame.iso,
                bbox: part.box.join(','),
                width: String(part.width),
                height: String(plan.height),
            });
            const { response, bytes } = await readSatelliteResponse(
                `${API_BASE}/satellite-view?${params}`,
                'image/png',
                SATELLITE_IMAGE_MAX,
                bounded.signal,
            );
            check();
            if (
                response.headers.get('x-thalassa-listed-time') !== frame.iso ||
                response.headers.get('x-thalassa-satellite-product') !== product ||
                response.headers.get('x-thalassa-satellite-window') !==
                    `${part.box.join(',')}:${part.width}x${plan.height}`
            )
                throw Error('Satellite image provenance mismatch');
            validateSatellitePng(bytes, part.width, plan.height);
            const bitmap = await awaitSatelliteOperation(
                createImageBitmap(new Blob([new Uint8Array(bytes).buffer], { type: 'image/png' })),
                bounded.signal,
                (late) => late.close(),
            );
            try {
                check();
                if (bitmap.width !== part.width || bitmap.height !== plan.height)
                    throw Error('Satellite decoded dimensions mismatch');
                context.drawImage(bitmap, part.left, 0, part.width, plan.height);
            } finally {
                bitmap.close();
            }
        }
        check();
        const pixels = context.getImageData(0, 0, plan.width, plan.height).data;
        let visible = 0;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) visible++;
        if (!visible) throw Error('Satellite image has no visible source pixels');
        const output = await awaitSatelliteOperation(
            new Promise<Blob>((resolve, reject) =>
                canvas.toBlob(
                    (value) => (value ? resolve(value) : reject(Error('Satellite PNG unavailable'))),
                    'image/png',
                ),
            ),
            bounded.signal,
        );
        check();
        if (output.size > SATELLITE_IMAGE_MAX) throw Error('Satellite viewport encoding exceeds bound');
        const url = URL.createObjectURL(output),
            owned = imageOwner(product, frame, plan, lease.times, visible / (plan.width * plan.height), url, current);
        if (!current()) {
            owned.releaseUnclaimed();
            throw Error('Satellite image retired before handoff');
        }
        return owned;
    } finally {
        bounded.finish();
    }
}
