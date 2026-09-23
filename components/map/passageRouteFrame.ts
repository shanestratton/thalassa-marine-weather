/** Geometry for the passage overview. This frames data; it never edits a route. */
export interface FramePoint {
    lat: number;
    lon: number;
}

export interface FramePadding {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface PassageFrameGeometry {
    points: [number, number][];
    bounds: [[number, number], [number, number]];
}

export function validFramePoint(point: FramePoint | null | undefined): point is FramePoint {
    return (
        !!point &&
        Number.isFinite(point.lat) &&
        Math.abs(point.lat) <= 90 &&
        Number.isFinite(point.lon) &&
        Math.abs(point.lon) <= 180
    );
}

/** Preserve the charted path's successive world copies across the date line. */
export function passageFrameGeometry(
    route: readonly FramePoint[],
    own: FramePoint | null,
    ghost: FramePoint | null,
    centreLongitude = 0,
): PassageFrameGeometry | null {
    if (route.length < 2 || route.some((point) => !validFramePoint(point))) return null;
    const points: [number, number][] = [];
    for (const point of route) {
        const reference = points.length ? points[points.length - 1][0] : point.lon;
        const lon = point.lon + 360 * Math.round((reference - point.lon) / 360);
        points.push([lon, point.lat]);
    }
    let west = Math.min(...points.map((point) => point[0]));
    let east = Math.max(...points.map((point) => point[0]));
    const middle = (west + east) / 2;
    for (const point of [own, ghost]) {
        if (!validFramePoint(point)) continue;
        points.push([point.lon + 360 * Math.round((middle - point.lon) / 360), point.lat]);
    }
    west = Math.min(...points.map((point) => point[0]));
    east = Math.max(...points.map((point) => point[0]));
    const worldShift = 360 * Math.round((centreLongitude - (west + east) / 2) / 360);
    const aligned = points.map(([lon, lat]): [number, number] => [lon + worldShift, lat]);
    return {
        points: aligned,
        bounds: [
            [west + worldShift, Math.min(...points.map((point) => point[1]))],
            [east + worldShift, Math.max(...points.map((point) => point[1]))],
        ],
    };
}

/** Fit farther inside than the visibility test, avoiding GPS/rounding jitter. */
export function passageFrameIsVisible(
    points: readonly [number, number][],
    project: (point: [number, number]) => { x: number; y: number },
    width: number,
    height: number,
    padding: FramePadding,
): boolean {
    if (!points.length || width <= 0 || height <= 0) return false;
    return points.every((point) => {
        const { x, y } = project(point);
        return (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            x >= padding.left - 6 &&
            x <= width - padding.right + 6 &&
            y >= padding.top - 6 &&
            y <= height - padding.bottom + 6
        );
    });
}

/** Do not ask Mapbox to fit into an impossible or zero-sized padded viewport. */
export function constrainFramePadding(padding: FramePadding, width: number, height: number): FramePadding {
    const shrink = (a: number, b: number, available: number): [number, number] => {
        const scale = Math.min(1, Math.max(0, available - 64) / Math.max(1, a + b));
        return [a * scale, b * scale];
    };
    const [left, right] = shrink(padding.left, padding.right, width);
    const [top, bottom] = shrink(padding.top, padding.bottom, height);
    return { top, right, bottom, left };
}

/** Measure the actual furniture, including safe-area offsets in its layout. */
export function passageFramePadding(container: HTMLElement): FramePadding {
    const rect = container.getBoundingClientRect();
    const root = container.closest('main') ?? container.parentElement ?? container;
    const padding: FramePadding = { top: 112, right: 88, bottom: 112, left: 24 };
    const measure = (selector: string, edge: keyof FramePadding) => {
        for (const element of root.querySelectorAll<HTMLElement>(selector)) {
            if (element.hidden || getComputedStyle(element).display === 'none') continue;
            const box = element.getBoundingClientRect();
            if (
                !box.width ||
                !box.height ||
                box.right <= rect.left ||
                box.left >= rect.right ||
                box.bottom <= rect.top ||
                box.top >= rect.bottom
            )
                continue;
            const inset =
                edge === 'left'
                    ? box.right - rect.left
                    : edge === 'right'
                      ? rect.right - box.left
                      : edge === 'top'
                        ? box.bottom - rect.top
                        : rect.bottom - box.top;
            padding[edge] = Math.max(padding[edge], inset + 20);
        }
    };
    measure('.thalassa-passage-hud, .thalassa-passage-hud-tab', 'left');
    measure('.thalassa-route-scrubber', 'bottom');
    measure(
        '[data-passage-frame-occlusion="top"], [aria-label^="Copernicus Marine data attribution"], a[aria-label="Rain radar data by RainViewer"], a[aria-label="Rain forecast imagery by Rainbow.ai"]',
        'top',
    );
    measure('[data-passage-frame-occlusion="right"]', 'right');
    return constrainFramePadding(padding, rect.width, rect.height);
}
