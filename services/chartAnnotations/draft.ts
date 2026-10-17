import type { Position } from 'geojson';
import { DRAW_VERTICES, drawingGeometry, type AnnotationGeometry, type DrawingKind } from './model';
export interface DrawingDraft {
    kind: DrawingKind;
    label: string;
    points: Position[];
    moving: boolean;
}
export function addDrawingPoint(draft: DrawingDraft, lon: number, lat: number): DrawingDraft {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 1e6)
        throw Error('Choose a valid chart point.');
    if (draft.points.length >= (draft.kind === 'label' ? 1 : DRAW_VERTICES))
        throw Error('Drawing corner limit reached. Undo or finish.');
    const point = [lon >= -180 && lon < 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180, lat];
    const previous = draft.points.at(-1);
    if (previous && previous[0] === point[0] && previous[1] === point[1]) return draft;
    return { ...draft, points: [...draft.points, point] };
}
export const finishDrawing = (draft: DrawingDraft): AnnotationGeometry => drawingGeometry(draft.kind, draft.points);
