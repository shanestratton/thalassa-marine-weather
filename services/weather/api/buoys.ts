
import { MAJOR_BUOYS } from '../config';
import { BuoyStation } from '../../../types';

export const fetchActiveBuoys = async (centerLat?: number, centerLon?: number): Promise<BuoyStation[]> => {
    let buoys = [...MAJOR_BUOYS];

    if (centerLat !== undefined && centerLon !== undefined) {
        buoys.sort((a, b) => {
            const distA = Math.pow(a.lat - centerLat, 2) + Math.pow(a.lon - centerLon, 2);
            const distB = Math.pow(b.lat - centerLat, 2) + Math.pow(b.lon - centerLon, 2);
            return distA - distB;
        });
    }

    return Promise.resolve(buoys);
};
