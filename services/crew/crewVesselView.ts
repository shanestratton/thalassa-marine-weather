/**
 * crewVesselView — the skipper's boat, as its accepted crew may see it.
 *
 * Shane 2026-10-03: "once a crew member has been invited to your vessel, can
 * we hide all of the rest of the information in his crew and float plan, it
 * should all pertain to the vessel that the punter has been invited on". The
 * Crew & Float Plan page then shows the SKIPPER'S boat: its name, who is
 * aboard (names and roles), and the identification a crew member needs to
 * make a Mayday.
 *
 * One read: public.get_crew_vessel_view (20261003120000), a SECURITY DEFINER
 * function that returns NULL for anyone who is not accepted crew and an
 * allow-list of the profile for those who are. Never the raw boat_profiles
 * row: that holds the EPIRB hex, shore contacts and phones, which go "only in
 * the float plan, to one chosen person" (types/vessel.ts).
 *
 * Until that migration is pushed the read degrades to what RLS already lets
 * crew see: names from boat_members, identification from vessel_identity,
 * peers' roles as 'Crew'. A missing function (PGRST202 / 42883) is told apart
 * from NULL, which means "not crew".
 *
 * The view is cached per account (authScopedStorageKey) so a crew member can
 * read it offline at sea; a network error (the auth refresh included) keeps
 * the cache, NULL purges it.
 * Supabase and the name grammar load lazily, so the Vessel hub can read the
 * cache without pulling either in.
 */
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { listCrewVessels } from '../vessel/sharedBinders';
import {
    aboardCount,
    CREW_ROLE_SENIORITY,
    mergeAboard,
    type AboardPerson,
    type FloatPlanSelfDetails,
} from './floatPlanPeople';
import { sortByCrewRank } from './crewRank';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('CrewVesselView');

// ── Types ──────────────────────────────────────────────────────

/** The allow-list. Nothing outside these keys is ever kept. */
const BRIEF_TEXT_KEYS = [
    'name',
    'type',
    'model',
    'riggingType',
    'hullType',
    'hullColor',
    'trimColor',
    'hullMaterial',
    'hailingPort',
    'registration',
    'mmsi',
    'callSign',
    'phoneticName',
    'sailNumber',
    'radiosMonitored',
    'prominentFeatures',
    'tenderDescription',
    'liferaftServiceDate',
    'flaresExpiry',
] as const;
const BRIEF_NUMBER_KEYS = [
    'length',
    'beam',
    'draft',
    'airDraft',
    'displacement',
    'cruisingSpeed',
    'crewCount',
    'liferaftCapacity',
    // The boat's own limits: Weather Windows on the skipper's passage scores
    // against the skipper's boat, not the crew member's own.
    'maxWindSpeed',
    'maxWaveHeight',
] as const;
const UNIT_KEYS = ['length', 'beam', 'draft', 'displacement', 'volume'] as const;

export type CrewVesselBrief = Partial<Record<(typeof BRIEF_TEXT_KEYS)[number], string>> &
    Partial<Record<(typeof BRIEF_NUMBER_KEYS)[number], number>>;

export type CrewVesselUnits = Partial<Record<(typeof UNIT_KEYS)[number], string>>;

export interface CrewRosterPerson {
    name: string;
    rank: string;
}

export interface CrewManifestEntry {
    isSkipper: boolean;
    isSelf: boolean;
    /** 'skipper', a crew role (co-skipper, navigator, deckhand, punter), or 'crew' when unknown. */
    role: string;
    /** Rendered byline; '' when the skipper has no name on record. */
    name: string;
}

export interface CrewVesselView {
    ownerId: string;
    vessel: CrewVesselBrief | null;
    vesselUnits: CrewVesselUnits | null;
    /** The skipper's vessel-profile roster (name and rank only); [] in degraded mode. */
    roster: CrewRosterPerson[];
    manifest: CrewManifestEntry[];
    fetchedAt: string;
    source: 'rpc' | 'fallback';
}

export type CrewVesselViewResult =
    | { status: 'fresh'; view: CrewVesselView }
    /** The server could not be asked; the cached view (or null) stands. */
    | { status: 'stale'; view: CrewVesselView | null }
    /** The server says this account is not accepted crew on that boat. */
    | { status: 'not-crew'; view: null }
    /** Signed out, or the account changed while reading. */
    | { status: 'discarded'; view: null };

type NameParts = {
    prefix?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    nickname?: string | null;
};
type RenderName = (parts: NameParts) => string;

// ── Labels ─────────────────────────────────────────────────────

/**
 * The invite picker's role names (INVITE_ROLE_OPTIONS), plus Skipper and the
 * degraded mode's Crew. Kept here so the hub and the page read one list
 * without loading the invite modal.
 */
const ROLE_LABELS: Readonly<Record<string, string>> = {
    skipper: 'Skipper',
    'co-skipper': 'Co-skipper',
    navigator: 'Navigator',
    deckhand: 'Deckhand',
    punter: 'Punter',
    crew: 'Crew',
};

export function crewRoleLabel(role: string | null | undefined): string {
    return (role && ROLE_LABELS[role]) || 'Crew';
}

/**
 * The boat's name for the crewing view. The view names the hull this account
 * is actually crew on (the RPC's hull, or the boat_members hull in degraded
 * mode); the snapshot's name comes from vessel_identity, which follows the
 * skipper's SELECTED boat. So the view's name wins, and the snapshot's
 * stands in until there is one. Null when neither is known.
 */
export function crewVesselName(
    snapshotName: string | null | undefined,
    view: CrewVesselView | null | undefined,
): string | null {
    return view?.vessel?.name?.trim() || snapshotName?.trim() || null;
}

/**
 * Who is aboard the skipper's boat, each person once (2026-10-04): his
 * profile roster's names and ranks and the app crew not already on it, in
 * rank order (Shane 2026-10-07: "order the punters on board by their rank"),
 * the same sortByCrewRank his own float plan uses. The caller's own row
 * carries their own name, phone and age from their Settings (`self`) and sits
 * at their rank like anyone else's; everyone else is a name and a role.
 */
export function crewVesselPeople(
    view: CrewVesselView | null | undefined,
    self?: FloatPlanSelfDetails | null,
): AboardPerson[] {
    if (!view) return [];
    return sortByCrewRank(
        mergeAboard(
            view.roster.map((person) => ({ name: person.name, role: person.rank })),
            view.manifest.map((entry) => ({
                appName: entry.name,
                role: crewRoleLabel(entry.role),
                isSkipper: entry.isSkipper,
                isSelf: entry.isSelf,
                ...(entry.isSelf && self ? { ownName: self.name, phone: self.phone, age: self.age } : {}),
            })),
        ),
    );
}

/** Souls aboard: everyone on crewVesselPeople, never fewer than the skipper's profile count. Null without a view. */
export function crewVesselAboard(
    view: CrewVesselView | null | undefined,
    self?: FloatPlanSelfDetails | null,
): number | null {
    return view ? aboardCount(crewVesselPeople(view, self).length, view.vessel?.crewCount) : null;
}

// ── Parsing (defence in depth: the allow-list again, client side) ──

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 500): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/\s+/g, ' ');
    return trimmed ? trimmed.slice(0, max) : null;
}

function parseBrief(value: unknown): CrewVesselBrief | null {
    if (!isRecord(value)) return null;
    const brief: Record<string, string | number> = {};
    for (const key of BRIEF_TEXT_KEYS) {
        const field = text(value[key]);
        if (field) brief[key] = field;
    }
    for (const key of BRIEF_NUMBER_KEYS) {
        const field = value[key];
        if (typeof field === 'number' && Number.isFinite(field)) brief[key] = field;
    }
    return brief as CrewVesselBrief;
}

function parseUnits(value: unknown): CrewVesselUnits | null {
    if (!isRecord(value)) return null;
    const units: CrewVesselUnits = {};
    for (const key of UNIT_KEYS) {
        const field = text(value[key], 16);
        if (field) units[key] = field;
    }
    return Object.keys(units).length > 0 ? units : null;
}

/** Name and rank only; a missing rank reads as rosterSeedsFromVesselProfile reads it. */
function parseRoster(value: unknown): CrewRosterPerson[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 99).flatMap((person, index): CrewRosterPerson[] => {
        if (!isRecord(person)) return [];
        const name = text(person.name, 120);
        if (!name) return [];
        return [{ name, rank: text(person.rank, 40) ?? (index === 0 ? 'Skipper' : 'Crew') }];
    });
}

function parseManifestEntry(value: unknown): CrewManifestEntry | null {
    if (!isRecord(value)) return null;
    const role = text(value.role, 32);
    const name = text(value.name, 160);
    if (typeof value.isSkipper !== 'boolean' || typeof value.isSelf !== 'boolean') return null;
    return { isSkipper: value.isSkipper, isSelf: value.isSelf, role: role ?? 'crew', name: name ?? '' };
}

/** A cached or freshly built view, re-validated field by field. */
function parseView(value: unknown, ownerId: string): CrewVesselView | null {
    if (!isRecord(value) || value.ownerId !== ownerId) return null;
    if (value.source !== 'rpc' && value.source !== 'fallback') return null;
    if (typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) return null;
    const manifest = Array.isArray(value.manifest)
        ? value.manifest.map(parseManifestEntry).filter((entry): entry is CrewManifestEntry => entry !== null)
        : [];
    return {
        ownerId,
        vessel: parseBrief(value.vessel),
        vesselUnits: parseUnits(value.vesselUnits),
        roster: Array.isArray(value.roster)
            ? value.roster.flatMap((person): CrewRosterPerson[] => {
                  if (!isRecord(person)) return [];
                  const name = text(person.name, 120);
                  const rank = text(person.rank, 40);
                  return name && rank ? [{ name, rank }] : [];
              })
            : [],
        manifest,
        fetchedAt: value.fetchedAt,
        source: value.source,
    };
}

/** The RPC's payload → a view. Null when the payload is not the shape the function returns. */
function fromRpcPayload(value: unknown, ownerId: string, renderName: RenderName): CrewVesselView | null {
    if (!isRecord(value) || !Array.isArray(value.manifest)) return null;
    const manifest = value.manifest.flatMap((entry): CrewManifestEntry[] => {
        if (!isRecord(entry) || typeof entry.isSkipper !== 'boolean' || typeof entry.isSelf !== 'boolean') return [];
        return [
            {
                isSkipper: entry.isSkipper,
                isSelf: entry.isSelf,
                role: text(entry.role, 32) ?? 'crew',
                name: renderName({
                    prefix: text(entry.prefix, 40),
                    first_name: text(entry.firstName, 80),
                    last_name: text(entry.lastName, 80),
                    nickname: text(entry.nickname, 80),
                }),
            },
        ];
    });
    return {
        ownerId,
        vessel: parseBrief(value.vessel),
        vesselUnits: parseUnits(value.vesselUnits),
        roster: parseRoster(value.roster),
        manifest,
        fetchedAt: new Date().toISOString(),
        source: 'rpc',
    };
}

// ── Cache (per account, swept by account deletion) ────────────

const CACHE_KEY = 'thalassa_crew_vessel_view_v1';
const listeners = new Set<() => void>();

interface CacheRecord {
    version: 1;
    cachedFor: string;
    views: Record<string, unknown>;
}

function readRecord(scope: AuthIdentityScope): CacheRecord | null {
    if (!scope.userId) return null;
    try {
        const raw = localStorage.getItem(authScopedStorageKey(CACHE_KEY, scope));
        if (!raw) return null;
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value) || value.version !== 1 || value.cachedFor !== scope.userId || !isRecord(value.views)) {
            return null;
        }
        return { version: 1, cachedFor: scope.userId, views: value.views };
    } catch {
        return null;
    }
}

function writeRecord(scope: AuthIdentityScope, views: Record<string, CrewVesselView>): void {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    try {
        const key = authScopedStorageKey(CACHE_KEY, scope);
        if (Object.keys(views).length === 0) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({ version: 1, cachedFor: scope.userId, views }));
    } catch {
        /* storage unavailable: the in-memory result still serves this render */
    }
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            log.warn('Crew vessel view listener failed:', error);
        }
    }
}

/** Every cached view for this account, pruned to the boats it still crews on (plus `keep`). */
function cachedViews(scope: AuthIdentityScope, keep?: string): Record<string, CrewVesselView> {
    const record = readRecord(scope);
    if (!record) return {};
    const owners = new Set(listCrewVessels().map((vessel) => vessel.ownerId));
    if (keep) owners.add(keep);
    const views: Record<string, CrewVesselView> = {};
    for (const [ownerId, value] of Object.entries(record.views)) {
        if (!owners.has(ownerId)) continue;
        const view = parseView(value, ownerId);
        if (view) views[ownerId] = view;
    }
    return views;
}

/** The cached view of one boat for the signed-in account, synchronously. */
export function getCachedCrewVesselView(ownerId: string | null | undefined): CrewVesselView | null {
    if (!ownerId) return null;
    const scope = getAuthIdentityScope();
    const record = readRecord(scope);
    return record ? parseView(record.views[ownerId], ownerId) : null;
}

/** Notified whenever a view is stored or purged. */
export function subscribeCrewVesselViews(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Drop one boat's cached view for the signed-in account (after leaving it). */
export function forgetCrewVesselView(ownerId: string): void {
    const scope = getAuthIdentityScope();
    if (ownerId && scope.userId && isAuthIdentityScopeCurrent(scope)) purgeView(scope, ownerId);
}

function storeView(scope: AuthIdentityScope, view: CrewVesselView): void {
    writeRecord(scope, { ...cachedViews(scope, view.ownerId), [view.ownerId]: view });
}

function purgeView(scope: AuthIdentityScope, ownerId: string): void {
    const views = cachedViews(scope);
    delete views[ownerId];
    writeRecord(scope, views);
}

// ── Load ───────────────────────────────────────────────────────

const DISCARDED = Object.freeze({ status: 'discarded' as const, view: null });
const NOT_CREW = Object.freeze({ status: 'not-crew' as const, view: null });

function isMissingFunction(error: unknown): boolean {
    const code = isRecord(error) ? error.code : undefined;
    return code === 'PGRST202' || code === '42883';
}

type FallbackClient = NonNullable<typeof import('../supabase').supabase>;

/**
 * Degraded mode: what accepted crew may already read. Names from boat_members
 * (RLS: members of the same boat), your own role from your own vessel_crew
 * rows, identification from vessel_identity. No email column is selected.
 */
async function loadFallback(
    client: FallbackClient,
    scope: AuthIdentityScope,
    selfId: string,
    ownerId: string,
    renderName: RenderName,
): Promise<CrewVesselView | 'not-crew' | 'failed'> {
    const { fetchVesselIdentityForOwner } = await import('../VesselIdentityService');
    const [members, own, identity] = await Promise.all([
        client
            .from('boat_members')
            .select(
                'user_id, role, prefix, first_name, last_name, nickname, boats!inner(id, name, owner_id, archived_at)',
            )
            .eq('boats.owner_id', ownerId)
            .is('boats.archived_at', null),
        client
            .from('vessel_crew')
            .select('owner_id, crew_user_id, status, role')
            .eq('crew_user_id', selfId)
            .eq('owner_id', ownerId)
            .eq('status', 'accepted'),
        fetchVesselIdentityForOwner(ownerId),
    ]);
    if (!isAuthIdentityScopeCurrent(scope)) return 'failed';
    if (members.error || own.error) return 'failed';

    const ownRows = (Array.isArray(own.data) ? own.data : []).filter(
        (row: Record<string, unknown>) =>
            isRecord(row) && row.owner_id === ownerId && row.crew_user_id === selfId && row.status === 'accepted',
    );
    if (ownRows.length === 0) return 'not-crew';
    const ownRole = ownRows
        .map((row: Record<string, unknown>) => (typeof row.role === 'string' ? row.role : ''))
        .sort((a: string, b: string) => (CREW_ROLE_SENIORITY[b] ?? 0) - (CREW_ROLE_SENIORITY[a] ?? 0))[0];

    type MemberRow = NameParts & { user_id?: unknown; boats?: unknown };
    const live = (Array.isArray(members.data) ? (members.data as MemberRow[]) : []).filter((row) => {
        const boat = isRecord(row?.boats) ? row.boats : null;
        return (
            boat !== null && boat.owner_id === ownerId && boat.archived_at == null && typeof row.user_id === 'string'
        );
    });
    // The hull the caller was bridged onto, as the RPC picks it.
    const ownHull = live.find((row) => row.user_id === selfId);
    const hullId = ownHull && isRecord(ownHull.boats) ? ownHull.boats.id : undefined;
    const hull = hullId === undefined ? [] : live.filter((row) => isRecord(row.boats) && row.boats.id === hullId);
    const hullName = ownHull && isRecord(ownHull.boats) ? text(ownHull.boats.name) : null;

    const skipperRow = hull.find((row) => row.user_id === ownerId);
    const crew = hull
        .filter((row) => row.user_id !== ownerId)
        .map(
            (row): CrewManifestEntry => ({
                isSkipper: false,
                isSelf: row.user_id === selfId,
                role: row.user_id === selfId ? ownRole || 'crew' : 'crew',
                name: renderName(row),
            }),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
    if (!crew.some((entry) => entry.isSelf)) {
        crew.push({ isSkipper: false, isSelf: true, role: ownRole || 'crew', name: '' });
    }

    // vessel_identity follows the skipper's SELECTED boat, which need not be
    // the hull this account is crew on. Its MMSI, rego and call sign go with
    // the hull only when the names agree; a mismatch keeps the hull's name
    // alone, so a Mayday block never mixes two boats.
    const boatKey = (name: string | null | undefined) => (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const identityIsHull =
        identity != null && (hullName === null || boatKey(hullName) === boatKey(identity.vessel_name));
    const vessel = parseBrief(
        identity && identityIsHull
            ? {
                  name: hullName ?? identity.vessel_name,
                  type: identity.vessel_type,
                  model: identity.model,
                  hullColor: identity.hull_color,
                  registration: identity.reg_number,
                  mmsi: identity.mmsi,
                  callSign: identity.call_sign,
                  phoneticName: identity.phonetic_name,
              }
            : hullName
              ? { name: hullName }
              : null,
    );
    return {
        ownerId,
        vessel,
        vesselUnits: null,
        roster: [],
        manifest: [
            { isSkipper: true, isSelf: false, role: 'skipper', name: skipperRow ? renderName(skipperRow) : '' },
            ...crew,
        ],
        fetchedAt: new Date().toISOString(),
        source: 'fallback',
    };
}

/**
 * Ask the server for one boat's crew view. Never throws. Fenced to the
 * account that started it: a result that lands after an account switch is
 * discarded, never cached.
 */
export async function loadCrewVesselView(ownerId: string): Promise<CrewVesselViewResult> {
    const scope = getAuthIdentityScope();
    const selfId = scope.userId;
    if (!ownerId || !selfId || !isAuthIdentityScopeCurrent(scope)) return DISCARDED;
    const stale = (): CrewVesselViewResult =>
        isAuthIdentityScopeCurrent(scope) ? { status: 'stale', view: getCachedCrewVesselView(ownerId) } : DISCARDED;

    try {
        const [{ supabase }, { renderCrewDisplayName }] = await Promise.all([
            import('../supabase'),
            import('../floatPlanCrew'),
        ]);
        if (!isAuthIdentityScopeCurrent(scope)) return DISCARDED;
        if (!supabase) return stale();
        const renderName: RenderName = (parts) => renderCrewDisplayName(parts);

        // The LOCAL session, not getUser(): offline at sea getUser() cannot
        // reach the auth server and answers {user: null}, which is not
        // "signed out" and must never hide the cached boat. The RPC enforces
        // auth.uid() on the server regardless.
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (!isAuthIdentityScopeCurrent(scope)) return DISCARDED;
        // A session that could not be refreshed (no network) is stale, not gone.
        if (sessionError) return stale();
        const sessionUserId = sessionData?.session?.user?.id;
        if (!sessionUserId || sessionUserId !== selfId) return DISCARDED;

        const { data, error } = await supabase.rpc('get_crew_vessel_view', { p_owner_id: ownerId });
        if (!isAuthIdentityScopeCurrent(scope)) return DISCARDED;

        if (!error) {
            if (data === null || data === undefined) {
                purgeView(scope, ownerId);
                return NOT_CREW;
            }
            const view = fromRpcPayload(data, ownerId, renderName);
            if (!view) {
                log.warn('Crew vessel view had an unexpected shape; keeping the cached view');
                return stale();
            }
            storeView(scope, view);
            return { status: 'fresh', view };
        }

        // DECIDED: degrade when the function is not pushed yet, and also when
        // any other error leaves nothing cached, so the page still names the
        // boat and its people. A cached view always beats the degraded one.
        const missing = isMissingFunction(error);
        if (!missing) {
            log.warn('Crew vessel view could not be read:', isRecord(error) ? error.message : error);
            if (getCachedCrewVesselView(ownerId)) return stale();
        }
        const fallback = await loadFallback(supabase, scope, selfId, ownerId, renderName);
        if (!isAuthIdentityScopeCurrent(scope)) return DISCARDED;
        if (fallback === 'failed') return stale();
        if (fallback === 'not-crew') {
            purgeView(scope, ownerId);
            return NOT_CREW;
        }
        storeView(scope, fallback);
        return { status: 'fresh', view: fallback };
    } catch (error) {
        log.warn('Crew vessel view request failed; keeping the cached view:', error);
        return stale();
    }
}
