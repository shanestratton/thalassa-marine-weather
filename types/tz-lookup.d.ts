declare module 'tz-lookup' {
    /**
     * Resolve the IANA timezone ID for a given latitude and longitude.
     * Offline lookup using bundled polygon data.
     *
     * @throws RangeError if lat is outside [-90, 90] or lon outside [-180, 180].
     */
    export default function tzLookup(lat: number, lon: number): string;
}
