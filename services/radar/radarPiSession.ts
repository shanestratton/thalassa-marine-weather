/** Shared, leased cache polling; a map unmount cannot retire an armed watch's independent lease. */
import { RadarStore, type RadarPiSession } from './radarStore';
import { loadPiRadarPicture } from './piRadar';
const holders = new Set<object>();
let generation = 0,
    timer: ReturnType<typeof setTimeout> | null = null,
    abort: AbortController | null = null,
    installed: RadarPiSession | null = null;
async function poll(epoch: number): Promise<void> {
    if (epoch !== generation || !holders.size) return;
    const controller = new AbortController();
    abort = controller;
    try {
        const picture = await loadPiRadarPicture({
            signal: controller.signal,
            isCurrent: () => epoch === generation && holders.size > 0,
        });
        if (epoch === generation && holders.size) installed = RadarStore.acceptPi(picture);
    } catch {
        /* Missing/stale feed is never evidence that a latched encounter passed. */
    } finally {
        if (epoch === generation && holders.size) {
            abort = null;
            timer = setTimeout(() => {
                timer = null;
                void poll(epoch);
            }, 2000);
        }
    }
}
export function retainPiRadar(): () => void {
    const holder = {};
    holders.add(holder);
    if (holders.size === 1) void poll(++generation);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders.delete(holder);
        if (holders.size) return;
        generation++;
        abort?.abort();
        abort = null;
        if (timer) clearTimeout(timer);
        timer = null;
        if (installed) RadarStore.retirePi(installed);
        installed = null;
    };
}
