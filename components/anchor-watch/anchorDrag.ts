/**
 * Dragging the anchor on the Move anchor preview (build 126, 126-07b).
 *
 * SwingCircleCanvas loads this only when it is given `onAnchorDrag`, which only
 * the Move anchor sheet gives it: the watch page's radar, Shore Watch's and the
 * dashboard's take no input, and the code is not in the app's first load.
 *
 *  - A drag starts only on the anchor: within 22 px of the glyph at the
 *    canvas centre (a 44 pt target). A touch anywhere else does nothing, and
 *    a tap that never moves 3 px is not a drag.
 *  - The anchor moves WITH the finger (where it was grabbed stays under it),
 *    and the canvas draws it and its circle there while the view stays put.
 *  - `move` is called at most once a frame, `end` once on release, and
 *    `cancel` when iOS takes the touch away mid-drag (a system gesture). Then
 *    nothing is set. A release is never a move: the sheet's Move is.
 */

type LatLon = { latitude: number; longitude: number };

/** Moving the previewed anchor by hand. */
export interface AnchorDragHandlers {
    /**
     * The anchor is being dragged to here (at most once a frame), measured from
     * `from`: the point the view was centred on when the finger went down.
     * Keep the view there until the drag ends, so the anchor stays under the
     * finger and what is drawn is what is reported.
     */
    move(lat: number, lon: number, from: LatLon): void;
    /** Let go here. */
    end(lat: number, lon: number): void;
    /** The touch was taken away mid-drag: nothing is set. */
    cancel(): void;
}

/** Where the canvas last drew: its centre (CSS px), px per metre, and the point at the centre. */
export interface AnchorDragGeometry {
    cx: number;
    cy: number;
    scale: number;
    centre: LatLon;
}

/** Half a 44 pt touch target. */
export const ANCHOR_GRAB_PX = 22;
/** Less than this is a tap, not a drag. */
const SLOP_PX = 3;

/**
 * The inverse of offsetFromAnchorM (SwingCircleCanvas): the point `dxM` metres
 * east and `dyM` north of `anchor` on the radar's flat local plane. Longitude
 * is wrapped into ±180° (a drag east over 180° lands in the west), latitude
 * clamped to ±90°.
 */
export function pointFromOffsetM(anchor: LatLon, dxM: number, dyM: number): LatLon {
    const metresPerDegreeEast = 111320 * Math.cos((anchor.latitude * Math.PI) / 180);
    const longitude = anchor.longitude + (metresPerDegreeEast > 1e-6 ? dxM / metresPerDegreeEast : 0);
    return {
        latitude: Math.max(-90, Math.min(90, anchor.latitude + dyM / 110540)),
        longitude: ((((longitude + 180) % 360) + 360) % 360) - 180,
    };
}

/**
 * Listen for a drag of the anchor on `canvas`. `geometry` is read when a touch
 * starts (null: nothing drawn, nothing to drag); `handlers` when one is
 * reported; `show` tells the canvas where to draw the dragged anchor (px from
 * the centre), or null to stop. Returns the detach.
 */
export function attachAnchorDrag(
    canvas: HTMLCanvasElement,
    geometry: () => AnchorDragGeometry | null,
    handlers: () => AnchorDragHandlers | undefined,
    show: (at: { dx: number; dy: number } | null) => void,
): () => void {
    let drag: {
        id: number;
        x: number;
        y: number;
        dx: number;
        dy: number;
        moved: boolean;
        geo: AnchorDragGeometry;
    } | null = null;
    let frame = 0;

    const local = (event: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const pointNow = () => {
        const { geo, dx, dy } = drag!;
        const point = pointFromOffsetM(geo.centre, dx / geo.scale, -dy / geo.scale);
        return [point.latitude, point.longitude] as const;
    };
    const follow = (event: PointerEvent) => {
        const { x, y } = local(event);
        drag!.dx = x - drag!.x;
        drag!.dy = y - drag!.y;
        drag!.moved ||= Math.hypot(drag!.dx, drag!.dy) >= SLOP_PX;
    };
    const stop = (event: PointerEvent) => {
        cancelAnimationFrame(frame);
        frame = 0;
        show(null);
        try {
            canvas.releasePointerCapture?.(event.pointerId);
        } catch {
            // Already released: nothing to give back.
        }
    };

    const onDown = (event: PointerEvent) => {
        if (drag || event.button > 0) return;
        const geo = geometry();
        if (!geo || !(geo.scale > 0)) return;
        const { x, y } = local(event);
        if (Math.hypot(x - geo.cx, y - geo.cy) > ANCHOR_GRAB_PX) return;
        drag = { id: event.pointerId, x, y, dx: 0, dy: 0, moved: false, geo };
        event.preventDefault();
        try {
            canvas.setPointerCapture?.(event.pointerId);
        } catch {
            // No capture (an old engine): the drag still follows over the canvas.
        }
    };
    const onMove = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        follow(event);
        if (!drag.moved) return;
        show({ dx: drag.dx, dy: drag.dy });
        frame ||= requestAnimationFrame(() => {
            frame = 0;
            if (drag) handlers()?.move(...pointNow(), drag.geo.centre);
        });
    };
    const onUp = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        follow(event);
        stop(event);
        const at = drag.moved ? pointNow() : null;
        drag = null;
        if (at) handlers()?.end(...at);
    };
    const onCancel = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        stop(event);
        const moved = drag.moved;
        drag = null;
        if (moved) handlers()?.cancel();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    return () => {
        cancelAnimationFrame(frame);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onCancel);
        drag = null;
        show(null);
    };
}
