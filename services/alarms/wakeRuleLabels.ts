import type { WakePreset } from '../../utils/wakeRule';
export const WAKE_LABELS: Record<WakePreset, string> = {
    'depth-below-keel': 'Depth below keel',
    'wind-above': 'True wind above',
    'speed-below': 'Ground speed below',
    'pressure-fall': 'Pressure fall / 3 h',
    'engine-coolant-above': 'Engine coolant above',
    'engine-oil-below': 'Engine oil pressure below',
    'engine-rpm-above': 'Engine RPM above',
    'battery-below': 'Battery voltage below',
};
