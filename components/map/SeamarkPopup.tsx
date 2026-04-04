/**
 * SeamarkPopup — Rich nautical feature info popup.
 *
 * Renders detailed information about a seamark when tapped on the map.
 * Displays name, type, light characteristics, colours, and position
 * in proper nautical formatting with human-readable light descriptions.
 */
import React from 'react';

interface SeamarkPopupProps {
    seamarkType: string;
    name: string;
    tags: Record<string, string>;
    coordinates: [number, number]; // [lon, lat]
}

// ── Nautical formatting helpers ──────────────────────────────────────────────

/** Format degrees decimal to DMS (e.g. 36°47.3'S) */
function formatCoord(value: number, isLat: boolean): string {
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const min = ((abs - deg) * 60).toFixed(1);
    const dir = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
    return `${deg}°${min}'${dir}`;
}

/** Human-readable seamark type name */
function formatType(type: string): string {
    const map: Record<string, string> = {
        buoy_lateral: 'Lateral Buoy',
        buoy_cardinal: 'Cardinal Buoy',
        buoy_isolated_danger: 'Isolated Danger Buoy',
        buoy_safe_water: 'Safe Water Mark',
        buoy_special_purpose: 'Special Purpose Buoy',
        buoy_installation: 'Installation Buoy',
        beacon_lateral: 'Lateral Beacon',
        beacon_cardinal: 'Cardinal Beacon',
        beacon_isolated_danger: 'Isolated Danger Beacon',
        beacon_safe_water: 'Safe Water Beacon',
        beacon_special_purpose: 'Special Purpose Beacon',
        light: 'Light',
        light_major: 'Major Light',
        light_minor: 'Minor Light',
        light_vessel: 'Light Vessel',
        light_float: 'Light Float',
        anchorage: 'Anchorage',
        anchor_berth: 'Anchor Berth',
        harbour: 'Harbour',
        mooring: 'Mooring',
        restricted_area: 'Restricted Area',
        cable_submarine: 'Submarine Cable',
        pipeline_submarine: 'Submarine Pipeline',
        separation_zone: 'Traffic Separation Zone',
        fairway: 'Fairway',
        recommended_track: 'Recommended Track',
        pilot_boarding: 'Pilot Boarding Point',
        signal_station_traffic: 'Traffic Signal Station',
        signal_station_warning: 'Warning Signal Station',
        coastguard_station: 'Coastguard Station',
        rescue_station: 'Rescue Station',
    };
    return map[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Discover all light prefixes in the tag set (light:, light:1:, light:2:, etc.) */
function findLightPrefixes(tags: Record<string, string>): string[] {
    const prefixes = new Set<string>();
    for (const key of Object.keys(tags)) {
        // Match patterns: light:character, light:1:character, light:2:colour, etc.
        const m = key.match(/^(light(?::\d+)?):/);
        if (m) prefixes.add(m[1] + ':');
    }
    // Ensure we always check the base 'light:' prefix
    prefixes.add('light:');
    // Sort so unnumbered comes first, then numbered in order
    return Array.from(prefixes).sort();
}

/** Build light characteristics string (e.g. "Fl(2)G.10s 12M") */
function formatLightCharacteristics(tags: Record<string, string>): string | null {
    const parts: string[] = [];

    // Scan ALL light prefixes found in tags
    for (const prefix of findLightPrefixes(tags)) {
        const character = tags[`${prefix}character`];
        const colour = tags[`${prefix}colour`];
        const period = tags[`${prefix}period`];
        const range = tags[`${prefix}range`];
        const group = tags[`${prefix}group`];

        if (character || colour) {
            let str = character || '';
            if (group) str += `(${group})`;
            if (colour) {
                const colourAbbr = colour.charAt(0).toUpperCase();
                str += colourAbbr;
            }
            if (period) str += `.${period}s`;
            if (range) str += ` ${range}M`;
            parts.push(str.trim());
        }
    }

    return parts.length > 0 ? parts.join(' / ') : null;
}

// ── Light character lookup tables ────────────────────────────────────────────

const LIGHT_CHAR_NAMES: Record<string, string> = {
    F: 'Fixed',
    Fl: 'Flashing',
    LFl: 'Long Flashing',
    Q: 'Quick Flashing',
    VQ: 'Very Quick Flashing',
    UQ: 'Ultra Quick Flashing',
    Oc: 'Occulting',
    Iso: 'Isophase',
    Mo: 'Morse',
    FFl: 'Fixed & Flashing',
    FlLFl: 'Flash + Long Flash',
    OcFl: 'Occulting + Flash',
    FFlFl: 'Fixed & Group Flashing',
    Al: 'Alternating',
    'Al.Fl': 'Alternating Flashing',
    'Al.Oc': 'Alternating Occulting',
    'Al.LFl': 'Alternating Long Flashing',
    IQ: 'Interrupted Quick',
    IVQ: 'Interrupted Very Quick',
    IUQ: 'Interrupted Ultra Quick',
};

const COLOUR_NAMES: Record<string, string> = {
    w: 'White',
    r: 'Red',
    g: 'Green',
    y: 'Yellow',
    b: 'Blue',
    or: 'Orange',
    bu: 'Blue',
    vi: 'Violet',
    am: 'Amber',
    white: 'White',
    red: 'Red',
    green: 'Green',
    yellow: 'Yellow',
    blue: 'Blue',
    orange: 'Orange',
    violet: 'Violet',
    amber: 'Amber',
};

/**
 * Parse IALA light characteristics into human-readable plain English.
 *
 * Examples:
 *   "Fl.G.2.5s"       → "Flashing Green, every 2.5 seconds"
 *   "Q(3)"            → "Quick Flashing, group of 3"
 *   "Fl(2)R.6s"       → "Flashing Red, group of 2, every 6 seconds"
 *   "Iso.W.4s"        → "Isophase White, period 4 seconds"
 *   "Mo(A)W.8s"       → "Morse (A) White, period 8 seconds"
 */
function formatLightPlainEnglish(tags: Record<string, string>): string | null {
    const descriptions: string[] = [];

    // Scan ALL light prefixes found in tags
    for (const prefix of findLightPrefixes(tags)) {
        const character = tags[`${prefix}character`];
        const colour = tags[`${prefix}colour`];
        const period = tags[`${prefix}period`];
        const range = tags[`${prefix}range`];
        const group = tags[`${prefix}group`];
        const sequence = tags[`${prefix}sequence`];

        if (!character && !colour) continue;

        const parts: string[] = [];

        // Character name
        if (character) {
            const charName = LIGHT_CHAR_NAMES[character] || character;
            parts.push(charName);
        }

        // Colour
        if (colour) {
            // Handle multi-colour (e.g. "white;red")
            const colourNames = colour.split(';').map((c) => {
                const cn = COLOUR_NAMES[c.trim().toLowerCase()];
                return cn || c.trim().charAt(0).toUpperCase() + c.trim().slice(1);
            });
            parts.push(colourNames.join(' & '));
        }

        // Join character + colour
        let desc = parts.join(' ');

        // Group
        if (group) {
            desc += `, group of ${group}`;
        }

        // Period
        if (period) {
            desc += `, every ${period}s`;
        }

        // Sequence (flash duration pattern)
        if (sequence && !period) {
            desc += `, sequence ${sequence}`;
        }

        // Range
        if (range) {
            desc += `. Visible ${range} nautical miles`;
        }

        if (desc) descriptions.push(desc);
    }

    return descriptions.length > 0 ? descriptions.join(' — ') : null;
}

/** Get colour emoji for a seamark */
function getColourIndicator(tags: Record<string, string>, type: string): string {
    const colourKey = `${type}:colour`;
    const colour = tags[colourKey] || '';

    const colourMap: Record<string, string> = {
        red: '🔴',
        green: '🟢',
        yellow: '🟡',
        black: '⚫',
        white: '⚪',
        orange: '🟠',
        blue: '🔵',
    };

    // Handle multi-colour (e.g., "red;white")
    const colours = colour.split(';').map((c) => c.trim());
    return (
        colours
            .map((c) => colourMap[c] || '')
            .filter(Boolean)
            .join('') || ''
    );
}

/** Get IALA category label */
function getCategoryLabel(tags: Record<string, string>, type: string): string | null {
    const catKey = `${type}:category`;
    const cat = tags[catKey];
    if (!cat) return null;
    return cat.charAt(0).toUpperCase() + cat.slice(1);
}

/** Get shape label */
function getShape(tags: Record<string, string>, type: string): string | null {
    const shapeKey = `${type}:shape`;
    const shape = tags[shapeKey];
    if (!shape) return null;
    return shape.charAt(0).toUpperCase() + shape.slice(1);
}

// ── Component ────────────────────────────────────────────────────────────────

export function SeamarkPopup({ seamarkType, name, tags, coordinates }: SeamarkPopupProps): React.ReactElement {
    const [lon, lat] = coordinates;
    const typeLabel = formatType(seamarkType);
    const lightChars = formatLightCharacteristics(tags);
    const lightPlain = formatLightPlainEnglish(tags);
    const colourEmoji = getColourIndicator(tags, seamarkType);
    const category = getCategoryLabel(tags, seamarkType);
    const shape = getShape(tags, seamarkType);
    const radarReflector = tags['radar_reflector'];
    const topmark = tags[`${seamarkType}:topmark:shape`] || tags['topmark:shape'];

    // Check for fog signal
    const fogSignal = tags['fog_signal:category'];
    const fogPeriod = tags['fog_signal:period'];

    return (
        <div
            style={{
                fontFamily: "'Inter', -apple-system, sans-serif",
                color: '#e2e8f0',
                padding: '12px 14px',
                minWidth: '200px',
            }}
        >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <span style={{ fontSize: '20px' }}>{colourEmoji || '🔱'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                        style={{
                            fontSize: '14px',
                            fontWeight: 800,
                            color: '#ffffff',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {name || typeLabel}
                    </div>
                    {name && (
                        <div
                            style={{
                                fontSize: '11px',
                                color: '#94a3b8',
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                            }}
                        >
                            {typeLabel}
                        </div>
                    )}
                </div>
            </div>

            {/* Details grid */}
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr',
                    gap: '4px 10px',
                    fontSize: '12px',
                }}
            >
                {category && (
                    <>
                        <span style={{ color: '#64748b', fontWeight: 700, fontSize: '11px' }}>Category</span>
                        <span style={{ fontWeight: 600 }}>{category}</span>
                    </>
                )}

                {shape && (
                    <>
                        <span style={{ color: '#64748b', fontWeight: 700, fontSize: '11px' }}>Shape</span>
                        <span style={{ fontWeight: 600 }}>{shape}</span>
                    </>
                )}

                {lightChars && (
                    <>
                        <span style={{ color: '#64748b', fontWeight: 700, fontSize: '11px' }}>Light</span>
                        <span
                            style={{
                                fontWeight: 700,
                                fontFamily: "'JetBrains Mono', monospace",
                                color: '#fbbf24',
                                fontSize: '12px',
                            }}
                        >
                            {lightChars}
                        </span>
                    </>
                )}

                {topmark && (
                    <>
                        <span style={{ color: '#64748b', fontWeight: 700, fontSize: '11px' }}>Topmark</span>
                        <span style={{ fontWeight: 600 }}>{topmark.charAt(0).toUpperCase() + topmark.slice(1)}</span>
                    </>
                )}

                {radarReflector && (
                    <>
                        <span style={{ color: '#64748b', fontWeight: 700, fontSize: '11px' }}>Radar</span>
                        <span style={{ fontWeight: 600 }}>{radarReflector === 'yes' ? '✅ Reflector' : '—'}</span>
                    </>
                )}

                {fogSignal && (
                    <>
                        <span style={{ color: '#64748b', fontWeight: 700, fontSize: '11px' }}>Fog</span>
                        <span style={{ fontWeight: 600 }}>
                            {fogSignal.charAt(0).toUpperCase() + fogSignal.slice(1)}
                            {fogPeriod ? ` (${fogPeriod}s)` : ''}
                        </span>
                    </>
                )}

                {/* Position — always shown */}
                <>
                    <span style={{ color: '#64748b', fontWeight: 700, fontSize: '11px' }}>Position</span>
                    <span
                        style={{
                            fontWeight: 600,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: '11px',
                            color: '#94a3b8',
                        }}
                    >
                        {formatCoord(lat, true)} {formatCoord(lon, false)}
                    </span>
                </>
            </div>

            {/* ── Human-readable light description ── */}
            {lightPlain && (
                <div
                    style={{
                        marginTop: '10px',
                        padding: '8px 10px',
                        background: 'rgba(251, 191, 36, 0.08)',
                        border: '1px solid rgba(251, 191, 36, 0.15)',
                        borderRadius: '8px',
                    }}
                >
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '6px',
                        }}
                    >
                        <span style={{ fontSize: '14px', lineHeight: '18px' }}>💡</span>
                        <span
                            style={{
                                fontSize: '12px',
                                fontWeight: 600,
                                color: '#fbbf24',
                                lineHeight: '18px',
                            }}
                        >
                            {lightPlain}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
