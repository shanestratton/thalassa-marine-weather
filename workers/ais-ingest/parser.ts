/**
 * parser.ts — Extract vessel records from AISStream.io messages.
 *
 * Handles PositionReport and ShipStaticData message types.
 */

export interface VesselRecord {
    mmsi: number;
    name?: string;
    call_sign?: string;
    ship_type?: number;
    destination?: string;
    imo_number?: number;
    lat?: number;
    lon?: number;
    cog?: number;
    sog?: number;
    heading?: number;
    nav_status?: number;
    dimension_a?: number;
    dimension_b?: number;
    dimension_c?: number;
    dimension_d?: number;
}

/** AISStream messages are small; reject oversized frames before JSON parsing. */
export const MAX_AIS_MESSAGE_CHARS = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validMmsi(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 100_000_000 && (value as number) <= 999_999_999;
}

function finiteInRange(value: unknown, min: number, max: number): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function validPosition(latValue: unknown, lonValue: unknown): { lat: number; lon: number } | null {
    const lat = finiteInRange(latValue, -90, 90);
    const lon = finiteInRange(lonValue, -180, 180);
    return lat === undefined || lon === undefined ? null : { lat, lon };
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
    const numeric = finiteInRange(value, min, max);
    return numeric !== undefined && Number.isInteger(numeric) ? numeric : undefined;
}

function optionalAisText(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    // AIS pads unused six-bit text with "@". Strip C0/C1 controls as well:
    // they have no maritime meaning and should never become stored UI data.
    let printable = '';
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (
            codePoint === undefined ||
            (codePoint >= 0 && codePoint <= 0x1f) ||
            (codePoint >= 0x7f && codePoint <= 0x9f)
        ) {
            continue;
        }
        printable += character;
    }
    const cleaned = printable.replace(/@+$/g, '').trim().slice(0, maxLength);
    return cleaned || undefined;
}

function positionRecord(payload: Record<string, unknown>, classB: boolean): VesselRecord | null {
    if (payload.Valid !== true || !validMmsi(payload.UserID)) return null;
    const position = validPosition(payload.Latitude, payload.Longitude);
    if (!position) return null;

    return {
        mmsi: payload.UserID,
        ...position,
        // AIS sentinel values (COG 360, SOG 102.3, heading 511) fall outside
        // these ranges and are omitted rather than stored as real movement.
        cog: finiteInRange(payload.Cog, 0, 359.9),
        sog: finiteInRange(payload.Sog, 0, 102.2),
        heading: optionalInteger(payload.TrueHeading, 0, 359),
        nav_status: classB ? 15 : optionalInteger(payload.NavigationalStatus, 0, 15),
    };
}

/**
 * Parse an AISStream.io WebSocket message into a VesselRecord.
 * Returns null if the message is not a supported type or is invalid.
 */
export function parseAisStreamMessage(raw: string): VesselRecord | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_AIS_MESSAGE_CHARS) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) return null;

    const type = parsed.MessageType;
    const message = parsed.Message;
    if (typeof type !== 'string' || !isRecord(message)) return null;

    // ── PositionReport (AIS message types 1, 2, 3) ──
    if (type === 'PositionReport') {
        const payload = message.PositionReport;
        return isRecord(payload) ? positionRecord(payload, false) : null;
    }

    // ── ShipStaticData (AIS message type 5) ──
    if (type === 'ShipStaticData') {
        const payload = message.ShipStaticData;
        if (!isRecord(payload) || payload.Valid !== true || !validMmsi(payload.UserID)) return null;
        const dimension = isRecord(payload.Dimension) ? payload.Dimension : {};

        return {
            mmsi: payload.UserID,
            name: optionalAisText(payload.Name, 20),
            call_sign: optionalAisText(payload.CallSign, 7),
            ship_type: optionalInteger(payload.Type, 0, 99),
            destination: optionalAisText(payload.Destination, 20),
            // Zero is AIS "not available", so only retain a seven-digit IMO.
            imo_number: optionalInteger(payload.ImoNumber, 1_000_000, 9_999_999),
            dimension_a: optionalInteger(dimension.A, 0, 511),
            dimension_b: optionalInteger(dimension.B, 0, 511),
            dimension_c: optionalInteger(dimension.C, 0, 63),
            dimension_d: optionalInteger(dimension.D, 0, 63),
        };
    }

    // ── StandardClassBPositionReport (AIS message type 18) ──
    if (type === 'StandardClassBPositionReport') {
        const payload = message.StandardClassBPositionReport;
        return isRecord(payload) ? positionRecord(payload, true) : null;
    }

    return null;
}
