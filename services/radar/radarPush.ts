/** A push is a refresh hint only. No card, owner binding or acknowledgement comes from its payload. */
import { PiRadarWatchStateStore } from './piRadarWatchState';
export function refreshRadarAlarmPush(data: Readonly<Record<string, unknown>>, explicitTap = false): boolean {
    if (data.notification_type !== 'radar_alarm') return false;
    void PiRadarWatchStateStore.refresh(explicitTap);
    return true;
}
