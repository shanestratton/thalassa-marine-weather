/** Half of the 1/12-degree ocean grid diagonal, with the caller's explicit pad. */
export function marineGridSnapKm(latitude: number, tolerance: number): number {
    const ns = (0.5 / 12) * 111.32;
    const ew = ns * Math.cos((latitude * Math.PI) / 180);
    return Math.hypot(ns, ew) * tolerance;
}
