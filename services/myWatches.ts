/**
 * The watches THIS crew member is standing — or nothing at all.
 *
 * Shane 2026-09-04: "how do we know what watch the punter is on. it should be
 * taken from the watch card of the passage planning… so if there is no watch
 * for this user, then nothing shows and that page does not exist."
 *
 * That last clause is the design. This returns an empty array for anyone with
 * no assigned watch — no voyage, no schedule, not on the bill, signed out —
 * and the UI is expected to render nothing rather than an empty state. A
 * watch page for someone with no watch is furniture.
 *
 * The matching rule is the one WatchAlarmService already uses, because the
 * page and the alarm must never disagree about whose watch it is: the
 * skipper assigns by email, and each crew device claims the rows carrying its
 * own address, compared case-insensitively.
 */
import { getActiveVoyage } from './VoyageService';
import { WatchAssignmentService } from './WatchAssignmentService';
import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';
import { watchStartAfter } from '../utils/watchTimes';

const log = createLogger('MyWatches');

export interface MyWatch {
    /** Stable across a voyage — the schedule's own index. */
    index: number;
    /** "First Watch", "Middle Watch". */
    label: string;
    /** "2000–0000", as the skipper wrote it. UTC. */
    timeLabel: string;
    /** The next time this watch actually begins. */
    startsAt: Date;
}

/**
 * Every watch assigned to the signed-in user on the active voyage, soonest
 * first. Empty whenever the answer is "none" — including every failure, since
 * a page that cannot prove the user has a watch must not claim they do.
 */
export async function myWatches(now: Date = new Date()): Promise<MyWatch[]> {
    try {
        if (!supabase) return [];
        const {
            data: { user },
        } = await supabase.auth.getUser();
        const email = user?.email?.trim().toLowerCase();
        if (!email) return [];

        const voyage = await getActiveVoyage();
        if (!voyage?.id || !voyage.departure_time) return [];

        const all = await WatchAssignmentService.list(voyage.id);
        const mine = all.filter(
            (a) => typeof a.assigned_crew_email === 'string' && a.assigned_crew_email.trim().toLowerCase() === email,
        );
        if (mine.length === 0) return [];

        const departure = voyage.departure_time;
        return mine
            .map((a) => {
                const startsAt = watchStartAfter(a.watch_time_label, departure, now);
                if (!startsAt) return null;
                return { index: a.watch_index, label: a.watch_label, timeLabel: a.watch_time_label, startsAt };
            })
            .filter((w): w is MyWatch => w !== null)
            .sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
    } catch (e) {
        // log.warn, not info: info is compiled out of production iOS builds,
        // and "the watch page vanished" needs to be diagnosable from a device.
        log.warn('Could not resolve this device’s watches', e);
        return [];
    }
}

/** The one the crew member is about to stand, if any. */
export function nextWatch(watches: MyWatch[]): MyWatch | null {
    return watches.length > 0 ? watches[0] : null;
}
