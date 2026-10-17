/** Borrow only an already-accounted, currently owned NOAA window. No I/O,
 * cache touch, new retention reservation, or geometry surviving owner release. */
import type { EncCell, EncConversionResult } from './types';
import { encCellContentIdentity } from './cellContentIdentity';
import { getVersion } from './EncCellMetadata';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
type Bounds = readonly [number, number, number, number];
interface Held {
    readonly token: number;
    blob?: EncConversionResult;
    bytes: number;
    bounds: Bounds;
    key: string;
    current: () => boolean;
}
const windows = new Set<Held>();
let revision = 0;
const identity = (cell: EncCell) =>
    JSON.stringify([
        encCellContentIdentity(cell),
        cell.sourceHO,
        cell.noaaPackage,
        cell.licence,
        cell.usage,
        cell.bbox,
    ]);
/** Called only after the actual signed/hash-verified local window has loaded
 * and its existing resident reservation is finalized. Max64 active receipts. */
export function registerRetainedNoaaWindow(
    cell: EncCell,
    bounds: Bounds,
    blob: EncConversionResult,
    bytes: number,
): () => void {
    if (windows.size >= 64 || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 16 * 1024 * 1024) return () => {};
    const scope = getAuthIdentityScope(),
        version = getVersion();
    let active = true;
    const held: Held = {
        token: ++revision,
        blob,
        bytes,
        bounds: Object.freeze([...bounds]) as Bounds,
        key: identity(cell),
        current: () => active && version === getVersion() && isAuthIdentityScopeCurrent(scope),
    };
    windows.add(held);
    return () => {
        if (!active) return;
        active = false;
        windows.delete(held);
        held.blob = undefined;
    };
}
export interface RetainedNoaaWindow {
    readonly blob: EncConversionResult | undefined;
    readonly bytes: number;
    isCurrent(): boolean;
    authorityCurrent(): boolean;
    release(): void;
}
function selectRetainedWindow(cell: EncCell, bounds: Bounds): Held | undefined {
    const key = identity(cell);
    let selected: Held | undefined;
    for (const held of windows) {
        if (
            !held.current() ||
            !held.blob ||
            held.key !== key ||
            held.bounds[0] > bounds[0] ||
            held.bounds[1] > bounds[1] ||
            held.bounds[2] < bounds[2] ||
            held.bounds[3] < bounds[3]
        )
            continue;
        if (!selected || held.bytes < selected.bytes) selected = held;
    }
    return selected;
}
export function retainedNoaaWindowIdentity(cell: EncCell, bounds: Bounds): number | null {
    return selectRetainedWindow(cell, bounds)?.token ?? null;
}
export function borrowRetainedNoaaWindow(cell: EncCell, bounds: Bounds): RetainedNoaaWindow | null {
    const selected = selectRetainedWindow(cell, bounds);
    if (!selected) return null;
    let owned: Held | undefined = selected;
    const bytes = selected.bytes;
    const weak = new WeakRef(selected);
    const authority = () => {
        const value = weak.deref();
        return !!value && windows.has(value) && value.current() && !!value.blob;
    };
    const current = () => !!owned && windows.has(owned) && owned.current() && !!owned.blob;
    return {
        get blob() {
            return current() ? owned!.blob : undefined;
        },
        bytes,
        isCurrent: current,
        authorityCurrent: authority,
        release: () => {
            owned = undefined;
        },
    };
}
