/**
 * Whether Obs may speak with the boat's own instruments (Shane 2026-10-06:
 * "if the punter selects wind and their is a metric for it, it should show
 * the vessels wind equipment").
 *
 * Only while the location box follows a boat (her row, or the boat crewed
 * on), and only when the instruments in the store are hers: the gateway
 * socket or the Pi over the boat LAN as her position chain takes them, or the
 * cloud row when it is her row (the store prefers the account's own row, so
 * while crewing it may be the other boat's). Current Location (the phone) or
 * a chosen place: the model, always.
 *
 * Ashore the store is empty on Obs (Shane 2026-10-07: "when you use your
 * vessel as your location, the wind in obs at zoom 14 no longer uses the
 * vessels wind data, even if it knows it"): only the Instrument Panel, the
 * Vessel hub and the open System status modal hold the cloud lane. So the
 * followed boat's wind also comes from her own cloud row through the boat
 * chain, the row the Obs camera and the boat marker already read. Obs does
 * not hold the cloud lane itself: that would hand her cloud position to every
 * consumer of the instrument store as if it were the phone's own ship. And
 * the close-in wind never takes her wind off the store's cloud lane, even
 * while a screen holds it: the store dates a cloud reading by when the phone
 * received it, so a wind the Pi could not date would read live there. The
 * chain path refuses it (pickCloudTrueWind).
 */
import { CloudTelemetryService } from '../../services/CloudTelemetryService';
import { NmeaStore } from '../../services/NmeaStore';
import {
    followedBoatCloudRowNow,
    followedBoatOwnsInstruments,
    lookUpFollowedBoatCloudRow,
} from '../../services/weatherPosition';
import { pickCloudTrueWind, type BoatWind } from './closeInWind';

export function boatInstrumentsFollowed(): boolean {
    try {
        return followedBoatOwnsInstruments(NmeaStore.getState(), CloudTelemetryService.getLatest()?.ownerId ?? null);
    } catch {
        return false;
    }
}

/** The followed boat's true wind from her cloud row, and where she was when it was read. */
export interface FollowedBoatCloudWind {
    wind: BoatWind;
    lat: number;
    lon: number;
}

/**
 * The followed boat's own true wind from her cloud row as this device last
 * read it, asking no one: null while the box follows the phone, when her row
 * is not usable now, or when it carries no wind the Pi dated inside the cloud
 * lane's 60 s gate (closeInWind pickCloudTrueWind). Never another boat's row.
 */
export function followedBoatCloudWind(now: number = Date.now()): FollowedBoatCloudWind | null {
    try {
        const row = followedBoatCloudRowNow(now);
        const wind = row ? pickCloudTrueWind(row, now) : null;
        return row && wind ? { wind, lat: row.lat, lon: row.lon } : null;
    } catch {
        return null;
    }
}

/** Read the followed boat's cloud row on the chain's shared 30 s throttle; nothing while the box follows the phone. */
export async function lookUpFollowedBoatWind(): Promise<void> {
    try {
        await lookUpFollowedBoatCloudRow();
    } catch {
        /* the next re-check asks again */
    }
}
