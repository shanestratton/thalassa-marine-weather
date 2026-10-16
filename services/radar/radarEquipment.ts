import type { MarineRadarEquipment, MarineRadarMake } from '../../types/marineRadar';
export const RADAR_MAKES: ReadonlyArray<{ id: MarineRadarMake; name: string }> = [
    { id: 'raymarine', name: 'Raymarine' },
    { id: 'garmin', name: 'Garmin' },
    { id: 'simrad', name: 'Simrad' },
    { id: 'furuno', name: 'Furuno' },
    { id: 'other', name: 'Other make' },
    { id: 'unknown', name: 'Make unknown' },
];
/** Official manufacturer names, checked 17 October 2026. These are equipment choices, not supported drivers. */
export const RADAR_MODELS: ReadonlyArray<{ id: string; make: MarineRadarMake; name: string }> = [
    { id: 'raymarine-quantum', make: 'raymarine', name: 'Quantum' },
    { id: 'raymarine-quantum-2', make: 'raymarine', name: 'Quantum 2 Doppler' },
    { id: 'raymarine-cyclone', make: 'raymarine', name: 'Cyclone' },
    { id: 'raymarine-magnum', make: 'raymarine', name: 'Magnum' },
    { id: 'raymarine-rd418hd', make: 'raymarine', name: 'RD418HD' },
    { id: 'raymarine-rd424hd', make: 'raymarine', name: 'RD424HD' },
    { id: 'garmin-fantom-18x', make: 'garmin', name: 'GMR Fantom 18x' },
    { id: 'garmin-fantom-24x', make: 'garmin', name: 'GMR Fantom 24x' },
    { id: 'garmin-18-hd3', make: 'garmin', name: 'GMR 18 HD3' },
    { id: 'garmin-18-xhd3', make: 'garmin', name: 'GMR 18 xHD3' },
    { id: 'garmin-24-xhd3', make: 'garmin', name: 'GMR 24 xHD3' },
    { id: 'simrad-halo20', make: 'simrad', name: 'HALO20' },
    { id: 'simrad-halo20plus', make: 'simrad', name: 'HALO20+' },
    { id: 'simrad-halo24', make: 'simrad', name: 'HALO24' },
    { id: 'simrad-halo2000', make: 'simrad', name: 'HALO 2000' },
    { id: 'simrad-halo3000', make: 'simrad', name: 'HALO 3000' },
    { id: 'furuno-drs4d-nxt', make: 'furuno', name: 'DRS4D-NXT' },
    { id: 'furuno-drs6a-nxt', make: 'furuno', name: 'DRS6A-NXT' },
    { id: 'furuno-drs12a-nxt', make: 'furuno', name: 'DRS12A-NXT' },
    { id: 'furuno-drs25a-nxt', make: 'furuno', name: 'DRS25A-NXT' },
];
export function radarEquipment(value: unknown): MarineRadarEquipment | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (
        Object.keys(v).length !== 4 ||
        v.schema !== 1 ||
        !RADAR_MAKES.some((m) => m.id === v.make) ||
        (v.modelId !== null && !RADAR_MODELS.some((m) => m.id === v.modelId && m.make === v.make)) ||
        (v.detail !== null &&
            (typeof v.detail !== 'string' || v.detail.length > 80 || !v.detail.trim() || /\p{Cc}/u.test(v.detail)))
    )
        return null;
    return {
        schema: 1,
        make: v.make as MarineRadarMake,
        modelId: v.modelId as string | null,
        detail: (v.detail as string | null)?.trim() ?? null,
    };
}
export function radarEquipmentLabel(value: unknown): string {
    const v = radarEquipment(value);
    if (!v) return value == null ? 'Not recorded' : 'Saved equipment needs review';
    const make = RADAR_MAKES.find((m) => m.id === v.make)!.name;
    return `${make} · ${RADAR_MODELS.find((m) => m.id === v.modelId)?.name ?? v.detail ?? 'model unknown'}`;
}
