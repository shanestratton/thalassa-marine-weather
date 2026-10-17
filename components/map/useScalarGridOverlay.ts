import { useMemo, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import {
    renderScalarGridImage,
    type ScalarColourStop,
    type ScalarGrid,
    type ScalarImageBounds,
} from '../../services/weather/scalarGridImage';
import { useOwnedImageOverlay, type OwnedImageStatus } from './useOwnedImageOverlay';

export type ScalarOverlayStatus = OwnedImageStatus;
export interface ScalarOverlayOptions {
    readonly id: string;
    readonly label: string;
    readonly credit: string;
    readonly enabled: boolean;
    readonly grid: ScalarGrid | null;
    readonly stops: readonly ScalarColourStop[];
    readonly revision: string;
    readonly sourceCurrent: () => boolean;
    readonly bounds?: ScalarImageBounds;
}

/** One 512² scalar texture; source lifetime and uncertain-visible attribution stay caller-owned. */
export function useScalarGridOverlay(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    options: ScalarOverlayOptions,
): ScalarOverlayStatus {
    const { grid, stops, bounds } = options;
    const boundsKey = bounds?.join(',') ?? '',
        paletteKey = JSON.stringify(stops);
    const prepare = useMemo(
        () => (check: () => void) => {
            if (!grid) throw new Error('Scalar grid absent');
            const image = renderScalarGridImage(grid, stops, { width: 512, height: 512, bounds, check });
            check();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Scalar canvas unavailable');
            const pixels = context.createImageData(image.width, image.height);
            pixels.data.set(image.data);
            context.putImageData(pixels, 0, 0);
            const url = canvas.toDataURL('image/png');
            if (!url.startsWith('data:image/png;base64,') || url.length > 2 * 1024 * 1024)
                throw new Error('Scalar image encoding failed');
            check();
            return { url, width: image.width, height: image.height, coordinates: image.coordinates };
            // Palette/bounds keep the original bounded value-key semantics. An equivalent
            // inline array cannot restart a healthy image on every status render.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        },
        [grid, paletteKey, boundsKey],
    );
    return useOwnedImageOverlay(mapRef, mapReady, {
        id: options.id,
        label: options.label,
        credit: options.credit,
        enabled: options.enabled,
        owner: grid,
        revision: options.revision,
        sourceCurrent: options.sourceCurrent,
        prepare,
        maxEdge: 512,
    });
}
