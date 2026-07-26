/**
 * NMEA gateway profiles shared by connection setup and status surfaces.
 *
 * These identify the gateway Thalassa is connected to, not necessarily the
 * physical GPS antenna behind it. Standard NMEA 0183 GPS sentences do not
 * carry a reliable receiver make/model.
 */

export const NMEA_DEVICE_PROFILES = [
    { id: 'ydwg02', label: 'Yacht Devices YDWG-02', port: '1456' },
    { id: 'ikonvert', label: 'Digital Yacht iKonvert', port: '2000' },
    { id: 'w2k1', label: 'Actisense W2K-1', port: '2000' },
    { id: 'signalk', label: 'Signal K Server', port: '10110' },
    { id: 'direct', label: 'Direct NMEA 0183 TCP', port: '10110' },
] as const;

export type NmeaDeviceProfileId = (typeof NMEA_DEVICE_PROFILES)[number]['id'];

export function getNmeaDeviceProfile(deviceId: string | null | undefined) {
    return NMEA_DEVICE_PROFILES.find((profile) => profile.id === deviceId) ?? null;
}

export function getNmeaDeviceLabel(deviceId: string | null | undefined): string {
    return getNmeaDeviceProfile(deviceId)?.label ?? 'NMEA 0183 gateway';
}
