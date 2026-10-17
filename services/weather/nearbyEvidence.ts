import { haversineNM } from '../../utils/gpsFollow';
import type { EvidenceStation } from './evidenceContract';

export interface EvidencePosition {
    readonly lat: number;
    readonly lon: number;
}
export function evidencePositionValid(position?: EvidencePosition | null): position is EvidencePosition {
    return (
        !!position &&
        Number.isFinite(position.lat) &&
        Math.abs(position.lat) <= 90 &&
        Number.isFinite(position.lon) &&
        Math.abs(position.lon) <= 180
    );
}
/** Local-only selection. Coordinates are never sent to the public publisher. */
export function nearestEvidenceStation(
    stations: readonly EvidenceStation[],
    position: EvidencePosition,
    nowSeconds: number,
    maxNm = 50,
): { station: EvidenceStation; distanceNm: number } | null {
    if (
        !evidencePositionValid(position) ||
        !Number.isFinite(nowSeconds) ||
        !Number.isFinite(maxNm) ||
        maxNm < 0 ||
        maxNm > 50
    )
        return null;
    let nearest: { station: EvidenceStation; distanceNm: number } | null = null;
    for (const station of stations) {
        if (nowSeconds >= station.expiresAt) continue;
        const distanceNm = haversineNM(position.lat, position.lon, station.lat, station.lon);
        if (
            distanceNm <= maxNm &&
            (!nearest ||
                distanceNm < nearest.distanceNm ||
                (distanceNm === nearest.distanceNm && station.key < nearest.station.key))
        )
            nearest = { station, distanceNm };
    }
    return nearest;
}
/** Exact own-server domains; deliberately distinct from 9km/Auto selections. */
export function issuedModelLabel(id: string): string {
    const names: Readonly<Record<string, string>> = {
        ecmwf_ifs025: 'ECMWF IFS 0.25°',
        ecmwf_aifs025_single: 'ECMWF AIFS 0.25°',
        dwd_icon: 'DWD ICON',
        ukmo_global_deterministic_10km: 'UK Met Office 10 km',
        jma_gsm: 'JMA GSM',
        gfs_seamless: 'GFS seamless',
        ecmwf_wam025: 'ECMWF WAM 0.25°',
        dwd_gwam: 'DWD GWAM',
        meteofrance_wave: 'Météo-France waves',
        ncep_gfswave025: 'GFS waves 0.25°',
    };
    return names[id] ?? id;
}
