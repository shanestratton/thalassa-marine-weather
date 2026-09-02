/**
 * chatUtils — Shared helpers for the chat system.
 * Single source of truth for avatar gradients, timestamps, crew ranks, and static maps.
 */

// ─── Avatar Color System ─────────────────────────────────────────────
const AVATAR_GRADIENTS = [
    'from-sky-400 to-sky-600',
    'from-emerald-400 to-emerald-600',
    'from-purple-400 to-purple-600',
    'from-red-400 to-red-600',
    'from-amber-400 to-amber-600',
    'from-rose-400 to-rose-600',
    'from-fuchsia-400 to-purple-600',
    'from-lime-400 to-emerald-600',
    'from-amber-400 to-red-600',
    'from-sky-400 to-sky-700',
];

export function getAvatarGradient(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = (hash << 5) - hash + userId.charCodeAt(i);
        hash |= 0;
    }
    return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

// ─── Relative Timestamp ──────────────────────────────────────────────
export function timeAgo(dateStr: string): string {
    const d = new Date(dateStr);
    const now = Date.now();
    const sec = Math.floor((now - d.getTime()) / 1000);
    if (sec < 60) return 'now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    if (sec < 604800) return `${Math.floor(sec / 86400)}d`;
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// ─── Crew Rank System ────────────────────────────────────────────────
export const CREW_RANKS: { min: number; badge: string; title: string }[] = [
    { min: 200, badge: '👑', title: 'Fleet Admiral' },
    { min: 100, badge: '🏆', title: 'Captain' },
    { min: 50, badge: '⭐', title: 'First Mate' },
    { min: 20, badge: '🎖️', title: 'Bosun' },
    { min: 5, badge: '⚓', title: 'Able Seaman' },
    { min: 0, badge: '🚢', title: 'Deckhand' },
];

export function getCrewRank(helpful: number) {
    return CREW_RANKS.find((r) => helpful >= r.min) || CREW_RANKS[CREW_RANKS.length - 1];
}

// ─── Static Map URL ──────────────────────────────────────────────────
export function getStaticMapUrl(lat: number, lng: number, zoom = 13, w = 300, h = 180, pinColor = 'ff4466'): string {
    const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    if (token && token.length > 10) {
        return `https://api.mapbox.com/styles/v1/mapbox/navigation-night-v1/static/pin-l+${pinColor}(${lng},${lat})/${lng},${lat},${zoom},0/${w}x${h}@2x?access_token=${token}&logo=false&attribution=false`;
    }
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=${zoom}&size=${w}x${h}&markers=${lat},${lng},ol-marker`;
}

// ─── Pin / Track Message Parsing ─────────────────────────────────────
export const PIN_PREFIX = '📍PIN:';
export const TRACK_PREFIX = '🗺️TRACK:';

/**
 * Fold a send result back over its optimistic row. One copy, shared by the
 * channel, DM, pin-drop and track-share senders (it used to be pasted into
 * each). `'queued'` marks the optimistic row as queued; `null` (send failed)
 * removes it; a real message replaces it — or is appended if the optimistic
 * row has already gone, unless the server echo is already in the list.
 */
export function reconcileOptimisticMessage<T extends { id: string; delivery_status?: string }>(
    messages: T[],
    optimisticId: string,
    result: T | 'queued' | null,
): T[] {
    const optimisticIndex = messages.findIndex((message) => message.id === optimisticId);
    if (result === 'queued') {
        return optimisticIndex < 0
            ? messages
            : messages.map((message) =>
                  message.id === optimisticId ? ({ ...message, delivery_status: 'queued' } as T) : message,
              );
    }
    if (!result) return optimisticIndex < 0 ? messages : messages.filter((message) => message.id !== optimisticId);
    if (optimisticIndex < 0) {
        return messages.some((message) => message.id === result.id) ? messages : [...messages, result];
    }
    const next = [...messages];
    next[optimisticIndex] = result;
    return next;
}

export type PinShareKind = 'current' | 'place' | 'pin';

export function getPinShareKind(caption: string): PinShareKind {
    if (/^\[LOC\]\s*/.test(caption)) return 'current';
    if (/^\[POI\]\s*/.test(caption)) return 'place';
    return 'pin';
}

/** Removes private transport tags before text is shown or exported. */
export function cleanPinShareCaption(caption: string): string {
    return caption.replace(/^\[(LOC|POI)\]\s*/i, '').trim();
}

export function parsePinMessage(msg: string): { lat: number; lng: number; caption: string } | null {
    if (!msg.startsWith(PIN_PREFIX)) return null;
    const rest = msg.slice(PIN_PREFIX.length);
    const [coords, ...captionParts] = rest.split('|');
    const [latStr, lngStr] = coords.split(',');
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (
        !latStr?.trim() ||
        !lngStr?.trim() ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
    ) {
        return null;
    }
    return { lat, lng, caption: captionParts.join('|').trim() };
}

export function parseTrackMessage(msg: string): { trackId: string; title: string } | null {
    if (!msg.startsWith(TRACK_PREFIX)) return null;
    const rest = msg.slice(TRACK_PREFIX.length);
    const [trackId, ...titleParts] = rest.split('|');
    return { trackId: trackId.trim(), title: titleParts.join('|').trim() || 'Shared Track' };
}

// ─── GPX Export ──────────────────────────────────────────────────────
const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function exportPinAsGPX(lat: number, lng: number, caption: string): Promise<void> {
    const userCaption = cleanPinShareCaption(caption);
    const safeName = userCaption.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'pin';
    const now = new Date().toISOString();
    // safeName is already alphanumeric, but caption is user-controlled —
    // an unescaped `&` or `<` breaks the GPX for every consumer.
    const safeDesc = escapeXml(userCaption);

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Thalassa Marine Weather"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${safeName}</name>
    <time>${now}</time>
  </metadata>
  <wpt lat="${lat}" lon="${lng}">
    <name>${safeName}</name>
    <desc>${safeDesc}</desc>
    <time>${now}</time>
  </wpt>
</gpx>`;

    const filename = `${safeName.replace(/\s+/g, '_')}_${lat.toFixed(4)}_${lng.toFixed(4)}.gpx`;

    // Use Capacitor native share (same pattern as logbook GPX export)
    const { shareGPXFile } = await import('../../services/gpxService');
    await shareGPXFile(gpx, filename);
}
