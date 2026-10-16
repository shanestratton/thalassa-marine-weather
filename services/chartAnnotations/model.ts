import type { Point, LineString, Polygon, Position } from 'geojson';
import { normalizeOverlay, record, safeLabel } from '../userOverlays/model';

export type AnnotationGeometry = Point | LineString | Polygon;
export type DrawingKind = 'line' | 'area' | 'label';
export const ANNOTATION_COUNT = 128;
export const ANNOTATION_VERTICES = 4096;
export const DRAW_VERTICES = 256;
export const ANNOTATION_BYTES = 256 * 1024;
export interface ChartAnnotation {
    id: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
    label: string;
    visible: boolean;
    geometry: AnnotationGeometry;
}
export interface AnnotationLibrary {
    schema: 1;
    revision: number;
    annotations: ChartAnnotation[];
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function drawingGeometry(kind: DrawingKind, points: readonly Position[]): AnnotationGeometry {
    if (points.length > DRAW_VERTICES || !['line', 'area', 'label'].includes(kind))
        throw Error('Drawing limit reached.');
    const coordinates = points.map((p) => [...p]);
    if (kind === 'label' && coordinates.length !== 1) throw Error('Place one label point.');
    if (kind === 'line' && coordinates.length < 2) throw Error('A line needs at least two points.');
    if (kind === 'area' && coordinates.length < 3) throw Error('An area needs at least three corners.');
    const input =
        kind === 'label'
            ? { type: 'Point', coordinates: coordinates[0] }
            : kind === 'line'
              ? { type: 'LineString', coordinates }
              : { type: 'Polygon', coordinates: [[...coordinates, coordinates[0]]] };
    return normalizeOverlay(input).data.features[0].geometry as AnnotationGeometry;
}
export function annotationVertices(geometry: AnnotationGeometry): number {
    return geometry.type === 'Point'
        ? 1
        : geometry.type === 'LineString'
          ? geometry.coordinates.length
          : geometry.coordinates.reduce((n, r) => n + r.length, 0);
}
/** A small user-created subset. No chart object, source properties or borrowed geometry is admitted. */
export function validateAnnotationLibrary(value: unknown): AnnotationLibrary {
    if (
        !record(value) ||
        value.schema !== 1 ||
        !Number.isSafeInteger(value.revision) ||
        (value.revision as number) < 0 ||
        !Array.isArray(value.annotations) ||
        value.annotations.length > ANNOTATION_COUNT
    )
        throw Error('Private drawing library is damaged.');
    const ids = new Set<string>();
    let vertices = 0;
    const annotations: ChartAnnotation[] = [];
    for (const row of value.annotations) {
        if (
            !record(row) ||
            typeof row.id !== 'string' ||
            !uuid.test(row.id) ||
            ids.has(row.id) ||
            !Number.isSafeInteger(row.revision) ||
            (row.revision as number) < 1 ||
            typeof row.createdAt !== 'number' ||
            !Number.isSafeInteger(row.createdAt) ||
            row.createdAt <= 0 ||
            typeof row.updatedAt !== 'number' ||
            !Number.isSafeInteger(row.updatedAt) ||
            row.updatedAt < row.createdAt ||
            row.updatedAt > 8.64e15 ||
            typeof row.visible !== 'boolean' ||
            typeof row.label !== 'string' ||
            !row.label ||
            safeLabel(row.label, '') !== row.label ||
            !record(row.geometry) ||
            !['Point', 'LineString', 'Polygon'].includes(String(row.geometry.type))
        )
            throw Error('Private drawing library is damaged.');
        const result = normalizeOverlay(row.geometry);
        if (result.vertices > DRAW_VERTICES + 1 || result.data.features.length !== 1)
            throw Error('Drawing has too many corners.');
        const geometry = result.data.features[0].geometry as AnnotationGeometry;
        if (JSON.stringify(row.geometry.coordinates) !== JSON.stringify(geometry.coordinates))
            throw Error('Only exact two-dimensional drawing coordinates are supported.');
        vertices += result.vertices;
        if (vertices > ANNOTATION_VERTICES) throw Error('Private drawing vertex limit reached.');
        ids.add(row.id);
        annotations.push({
            id: row.id,
            revision: row.revision as number,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            label: row.label,
            visible: row.visible,
            geometry,
        });
    }
    const library: AnnotationLibrary = { schema: 1, revision: value.revision as number, annotations };
    if (new TextEncoder().encode(JSON.stringify(library)).length > ANNOTATION_BYTES)
        throw Error('Private drawing byte limit reached.');
    return library;
}
export const annotationId = () => crypto.randomUUID();
