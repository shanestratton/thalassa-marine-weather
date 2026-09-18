/** Display-only copy/icons. Never use this for map layers or their colour keys. */
const DAYLIGHT_TONES: Record<string, string> = {};
for (const [tone, colors] of Object.entries({
    text: ['#ffffff', '#fff', '#e2e8f0'],
    muted: ['#475569', '#64748b', '#6b7280', '#94a3b8', '#9ca3af', '#cbd5e1'],
    accent: ['#0ea5e9', '#22d3ee', '#38bdf8', '#3a8dbf', '#60a5fa', '#67e8f9', '#7dd3fc'],
    success: ['#10b981', '#14b8a6', '#22c55e', '#34d399', '#5eead4', '#6ee7b7'],
    amber: ['#a8956a', '#f59e0b', '#fbbf24', '#fcd34d', '#facc15', '#fde047'],
    orange: ['#f97316', '#fb923c', '#fdba74'],
    danger: ['#ef4444', '#f87171', '#fca5a5'],
    purple: ['#8b5cf6', '#a78bfa', '#a855f7', '#c4b5fd', '#f0abfc'],
    magenta: ['#d837a9', '#e879f9'],
})) {
    for (const color of colors) DAYLIGHT_TONES[color] = tone;
}

/** Keeps each semantic hue and the exact original dark/night colour. */
export function daylightUiColor(color: string): string {
    const key = /^#[\da-f]{8}$/i.test(color) ? color.slice(0, 7) : color;
    const tone = /^rgba\(255,\s*255,\s*255,\s*0\.\d+\)$/i.test(color) ? 'muted' : DAYLIGHT_TONES[key.toLowerCase()];
    return tone ? `var(--day-ui-${tone}, ${color})` : color;
}
