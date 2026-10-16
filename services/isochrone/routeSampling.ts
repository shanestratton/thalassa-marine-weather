/** Bounded spatial/hourly checkpoints plus the field's actual forecast clock knots. */
export function routeSampleFractions(
    startHours: number,
    endHours: number,
    distanceNm: number,
    forecastHours: readonly number[] | undefined,
    remaining: number,
): number[] | null {
    const duration = endHours - startHours;
    if (![startHours, endHours, distanceNm].every(Number.isFinite) || duration < 0 || distanceNm < 0) return null;
    const steps = Math.max(1, Math.ceil(distanceNm / 5), Math.ceil(duration));
    if (steps + 1 > remaining || (forecastHours?.length ?? 0) > 2000) return null;
    const fractions = new Set(Array.from({ length: steps + 1 }, (_, index) => index / steps));
    const add = (hour: number) => {
        if (Number.isFinite(hour) && hour > startHours && hour < endHours)
            fractions.add((hour - startHours) / duration);
    };
    for (let hour = Math.ceil(startHours); hour < endHours; hour++) add(hour);
    for (const hour of forecastHours ?? []) add(hour);
    return fractions.size > remaining ? null : [...fractions].sort((a, b) => a - b);
}
