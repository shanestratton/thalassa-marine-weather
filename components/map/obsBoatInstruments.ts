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
 */
import { CloudTelemetryService } from '../../services/CloudTelemetryService';
import { NmeaStore } from '../../services/NmeaStore';
import { followedBoatOwnsInstruments } from '../../services/weatherPosition';

export function boatInstrumentsFollowed(): boolean {
    try {
        return followedBoatOwnsInstruments(NmeaStore.getState(), CloudTelemetryService.getLatest()?.ownerId ?? null);
    } catch {
        return false;
    }
}
