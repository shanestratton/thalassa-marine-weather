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

/**
 * Parse an AISStream.io WebSocket message into a VesselRecord.
 * Returns null if the message is not a supported type or is invalid.
 */
export function parseAisStreamMessage(raw: string): VesselRecord | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any;
    try {
        msg = JSON.parse(raw);
    } catch {
        return null;
    }

    const type = msg.MessageType;
    if (!type) return null;

    // ── PositionReport (AIS message types 1, 2, 3) ──
    if (type === 'PositionReport') {
        const pr = msg.Message?.PositionReport;
        if (!pr || !pr.Valid) return null;

        const mmsi = pr.UserID;
        if (!mmsi || mmsi <= 0) return null;

        // Filter out invalid positions
        const lat = pr.Latitude;
        const lon = pr.Longitude;
        if (lat === undefined || lon === undefined) return null;
        if (lat === 91 || lon === 181) return null; // AIS "not available" values
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

        return {
            mmsi,
            lat,
            lon,
            cog: pr.Cog ?? undefined,
            sog: pr.Sog ?? undefined,
            heading: pr.TrueHeading ?? undefined,
            nav_status: pr.NavigationalStatus ?? undefined,
        };
    }

    // ── ShipStaticData (AIS message type 5) ──
    if (type === 'ShipStaticData') {
        const sd = msg.Message?.ShipStaticData;
        if (!sd || !sd.Valid) return null;

        const mmsi = sd.UserID;
        if (!mmsi || mmsi <= 0) return null;

        const name = sd.Name?.replace(/@+$/g, '').trim() || undefined;
        const destination = sd.Destination?.replace(/@+$/g, '').trim() || undefined;

        return {
            mmsi,
            name,
            call_sign: sd.CallSign?.trim() || undefined,
            ship_type: sd.Type ?? undefined,
            destination,
            imo_number: sd.ImoNumber ?? undefined,
            dimension_a: sd.Dimension?.A ?? undefined,
            dimension_b: sd.Dimension?.B ?? undefined,
            dimension_c: sd.Dimension?.C ?? undefined,
            dimension_d: sd.Dimension?.D ?? undefined,
        };
    }

    // ── StandardClassBPositionReport (AIS message type 18) ──
    if (type === 'StandardClassBPositionReport') {
        const bp = msg.Message?.StandardClassBPositionReport;
        if (!bp || !bp.Valid) return null;

        const mmsi = bp.UserID;
        if (!mmsi || mmsi <= 0) return null;

        const lat = bp.Latitude;
        const lon = bp.Longitude;
        if (lat === undefined || lon === undefined) return null;
        if (lat === 91 || lon === 181) return null;

        return {
            mmsi,
            lat,
            lon,
            cog: bp.Cog ?? undefined,
            sog: bp.Sog ?? undefined,
            heading: bp.TrueHeading ?? undefined,
            nav_status: 15, // Class B — not defined
        };
    }

    return null;
}
