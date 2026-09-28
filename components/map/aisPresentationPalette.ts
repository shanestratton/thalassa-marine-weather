/** One palette for the AIS map targets, projected tracks and their key. */
export const AIS_TYPE_PALETTE = {
    cargo: { color: '#22c55e', label: 'Cargo' },
    tanker: { color: '#ef4444', label: 'Tanker' },
    passenger: { color: '#3b82f6', label: 'Passenger' },
    fishing: { color: '#f97316', label: 'Fishing' },
    pleasure: { color: '#a855f7', label: 'Sailing / pleasure' },
    service: { color: '#eab308', label: 'Tug / pilot / SAR / special' },
    highSpeed: { color: '#06b6d4', label: 'High-speed craft' },
    unknown: { color: '#94a3b8', label: 'Unknown type' },
} as const;

/** Outside every type bucket: an unsafe navigation status overrides type. */
export const AIS_DANGER_COLOR = '#f5009b';
export const AIS_LEGEND_ITEMS = [
    ...Object.values(AIS_TYPE_PALETTE),
    { color: AIS_DANGER_COLOR, label: 'NUC / restricted / draught / aground' },
] as const;

export function typeBucketColor(shipType: number): string {
    if (shipType >= 70 && shipType <= 79) return AIS_TYPE_PALETTE.cargo.color;
    if (shipType >= 80 && shipType <= 89) return AIS_TYPE_PALETTE.tanker.color;
    if (shipType >= 60 && shipType <= 69) return AIS_TYPE_PALETTE.passenger.color;
    if (shipType === 30) return AIS_TYPE_PALETTE.fishing.color;
    if (shipType === 36 || shipType === 37) return AIS_TYPE_PALETTE.pleasure.color;
    if ((shipType >= 31 && shipType <= 35) || (shipType >= 50 && shipType <= 58)) return AIS_TYPE_PALETTE.service.color;
    if (shipType >= 40 && shipType <= 49) return AIS_TYPE_PALETTE.highSpeed.color;
    return AIS_TYPE_PALETTE.unknown.color;
}
