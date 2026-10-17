import { supabase } from '../supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { satelliteModeActive } from '../networkPolicy';
import { cachedConvectiveMember, weatherWatchCell } from '../../utils/cachedConvective';
import { CONVECTIVE_MODELS, convectiveContext, type ConvectiveMember } from '../../utils/convective';
import { composeBriefing, type Briefing } from './composeBriefing';
import { withTimeout } from '../../utils/deadline';
/** Reads already-published own forecasts only. No provider request or background refresh. */
export async function cachedBriefing(
    point: { lat: number; lon: number },
    place: string,
    zone: string,
    now: number,
): Promise<Briefing | null> {
    const scope = getAuthIdentityScope();
    if (
        !scope.userId ||
        !supabase ||
        satelliteModeActive() ||
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lon) ||
        Math.abs(point.lat) >= 90 ||
        Math.abs(point.lon) > 180
    )
        return null;
    const cell = weatherWatchCell(point.lat, point.lon);
    const answer = await withTimeout(
        Promise.resolve(
            supabase
                .from('wx_point_forecasts')
                .select('cell_id,model,run_at,payload')
                .eq('cell_id', cell)
                .in(
                    'model',
                    CONVECTIVE_MODELS.map((id) => `wx2:${id}`),
                )
                .limit(3),
        ),
        null,
        4000,
    );
    if (!isAuthIdentityScopeCurrent(scope) || !answer || answer.error || !Array.isArray(answer.data)) return null;
    const members = answer.data
        .map((row) => cachedConvectiveMember(row, cell, now))
        .filter((m): m is ConvectiveMember => !!m);
    const at = Math.floor(now / 3_600_000) * 3_600_000;
    return composeBriefing({
        place,
        zone,
        now,
        forecastAt: members.length ? Math.min(...members.map((m) => m.runAt)) : null,
        official: { state: 'unavailable' },
        convective: convectiveContext(members, at, point.lat, now),
        models: members.map(
            (member) =>
                ({ ecmwf_ifs025: 'ECMWF', dwd_icon: 'DWD ICON', ukmo_global_deterministic_10km: 'UKMO' })[member.model],
        ),
    });
}
