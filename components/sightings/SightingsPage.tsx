/**
 * Sightings (Shane 2026-10-05: "something that will appeal to all the tree
 * huggers, something really good, something that governments will be
 * jealous of"). Reached from Scuttlebutt; Back returns there.
 *
 *   Crew   — the boat's sightings, LIVE, for the skipper and his accepted
 *            crew (RLS on the server), with this phone's unsent ones merged
 *            in. Offline: the last copy, and when it was fetched.
 *   Public — everyone's, THREE HOURS LATE and on a grid (1 km, 8 km for
 *            threatened species), decided by the server. No fish, no photos.
 *   Mine   — your list, your map (exact, only you and your crew see it), and
 *            the life list: "<Boat>'s species: N" with first-seen dates.
 *
 * Every state says where things are: waiting to send, not on the server yet
 * (the migration is not pushed), signed out (logging still works, Private, on
 * this phone), empty.
 */
import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { retrySightingPosition } from '../../services/sightings/sightingService';
import { scheduleSightingDrain } from '../../services/sightings/sightingSync';
import { PageHeader } from '../ui/PageHeader';
import { SignInButton } from '../ui/SignInButton';
import { useUIStore } from '../../stores/uiStore';
import { useWeatherStore } from '../../stores/weatherStore';
import { lazyRetry } from '../../utils/lazyRetry';
import { loadCatalogue, isCoarsePublic, type SightingCatalogue } from '../../services/sightings/catalogue';
import { feedBoats, useSightingsSession } from '../../hooks/sightings/useSightingsSession';
import {
    useBoatSpecies,
    useCrewSightings,
    useMergedCrewFeed,
    useMySightings,
    usePublicSightings,
} from '../../hooks/sightings/useSightingFeeds';
import { BinocularsGlyph } from './BinocularsGlyph';
import { SIGHTINGS_SEEN_KEY } from './SightingsEntryCard';
import { QuickLogSheet } from './QuickLogSheet';
import { isRecentForRetry, SightingDetail } from './SightingDetail';
import { DayGroupedList, LifeList, SightingRow } from './SightingList';
import { SightingIcon, type SightingIconName } from './SightingGlyphs';
import {
    agoLabel,
    areaLabel,
    formatClock,
    formatPosition,
    itemFromLocal,
    itemFromPublic,
    itemFromServer,
    observerLabel,
    SYNC_LABEL,
    type SightingItem,
} from './sightingsFormat';
import './sightings.css';

const SightingsMap = lazyRetry(() => import('./SightingsMap'), 'SightingsMap');
const SignInScreen = lazyRetry(
    () => import('../SignInScreen').then((m) => ({ default: m.SignInScreen })),
    'SignInScreen',
);

type Tab = 'crew' | 'public' | 'mine';
type MineView = 'list' | 'map' | 'life';
const TAB_KEY = 'thalassa_sightings_tab_v1';
const RADII = [25, 100, 500] as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function readTab(): Tab | null {
    try {
        const v = localStorage.getItem(TAB_KEY);
        return v === 'crew' || v === 'public' || v === 'mine' ? v : null;
    } catch {
        return null;
    }
}

function writeTab(tab: Tab) {
    try {
        localStorage.setItem(TAB_KEY, tab);
    } catch {
        /* a nicety */
    }
}

/** A state card: an icon tile, a heading, a line, and maybe an action. */
const StateCard: React.FC<{
    icon: SightingIconName | 'binoculars';
    title: string;
    children?: React.ReactNode;
    action?: React.ReactNode;
    testId?: string;
}> = ({ icon, title, children, action, testId }) => (
    <section className="sg-card flex items-start gap-3 p-3.5" data-testid={testId}>
        <span aria-hidden="true" className="sg-chip flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
            {icon === 'binoculars' ? (
                <BinocularsGlyph className="h-5 w-5" />
            ) : (
                <SightingIcon name={icon} className="h-5 w-5" />
            )}
        </span>
        <div className="min-w-0 flex-1">
            <h2 className="text-[14.5px] font-extrabold leading-tight text-white">{title}</h2>
            {children && <div className="mt-0.5 text-[12.5px] leading-snug sg-muted">{children}</div>}
            {action && <div className="mt-2.5">{action}</div>}
        </div>
    </section>
);

/** Beside a Mine row that is waiting for a position, while the moment is still recent. */
const RetryPositionButton: React.FC<{ id: string; signedIn: boolean }> = ({ id, signedIn }) => {
    const [busy, setBusy] = useState(false);
    return (
        <button
            type="button"
            disabled={busy}
            aria-label="Retry the position"
            onClick={() => {
                setBusy(true);
                void retrySightingPosition(id).then((result) => {
                    setBusy(false);
                    if (result === 'attached' && signedIn) scheduleSightingDrain(0);
                });
            }}
            className="min-h-[44px] shrink-0 rounded-full border border-amber-400/50 px-3 text-[13px] font-extrabold sg-amber-strong"
        >
            {busy ? 'Finding…' : 'Retry'}
        </button>
    );
};

const Segmented = <T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: Array<{ value: T; label: React.ReactNode; name: string }>;
    onChange: (v: T) => void;
}) => (
    <div role="group" aria-label={label} className="sg-seg flex gap-1 p-1">
        {options.map((o) => (
            <button
                key={o.value}
                type="button"
                aria-pressed={value === o.value}
                aria-label={o.name}
                onClick={() => onChange(o.value)}
                className="sg-toggle sg-seg-btn"
            >
                {o.label}
            </button>
        ))}
    </div>
);

export interface SightingsPageProps {
    onBack: () => void;
    backLabel?: string;
    breadcrumbs?: string[];
}

export const SightingsPage: React.FC<SightingsPageProps> = ({ onBack, backLabel, breadcrumbs }) => {
    const session = useSightingsSession();
    const isOffline = useUIStore((s) => s.isOffline);
    const weatherCentre = useWeatherStore((s) => s.weatherData?.coordinates ?? null);
    const weatherPlace = useWeatherStore((s) => s.weatherData?.locationName?.trim() || null);
    const boats = useMemo(() => feedBoats(session), [session]);
    const [boatIndex, setBoatIndex] = useState(0);
    const boat = boats[Math.min(boatIndex, Math.max(0, boats.length - 1))] ?? null;

    // First visit: the crew feed when there is a boat to show, else your own.
    const [tab, setTabState] = useState<Tab>(() => readTab() ?? (session.userId && boat ? 'crew' : 'mine'));
    const setTab = (t: Tab) => {
        setTabState(t);
        writeTab(t);
    };
    const [mineView, setMineView] = useState<MineView>('list');
    const [lifeScope, setLifeScope] = useState<'boat' | 'me'>('boat');
    const [radius, setRadius] = useState<(typeof RADII)[number]>(100);
    const [logOpenedAt, setLogOpenedAt] = useState<number | null>(null);
    const [detail, setDetail] = useState<SightingItem | null>(null);
    const [signIn, setSignIn] = useState(false);
    const [catalogue, setCatalogue] = useState<SightingCatalogue | null>(null);
    const [adoptNote, setAdoptNote] = useState<string | null>(null);

    const mine = useMySightings(session.userId);
    const crew = useCrewSightings(session.userId ? (boat?.ownerId ?? null) : null, isOffline);
    const merged = useMergedCrewFeed(crew.rows, mine.records, boat?.ownerId ?? null, mine.deletedIds);

    const myItems = useMemo(() => mine.records.map(itemFromLocal), [mine.records]);
    const crewItems = useMemo(
        () => merged.map((m) => (m.local ? itemFromLocal(m.local) : itemFromServer(m.server!))),
        [merged],
    );

    const newestOwnPosition = myItems.find((i) => i.latitude !== null && i.longitude !== null);
    const centre =
        weatherCentre ??
        (newestOwnPosition ? { lat: newestOwnPosition.latitude!, lon: newestOwnPosition.longitude! } : null);
    const pub = usePublicSightings(centre, radius, tab === 'public' && !!session.userId && !isOffline);
    // Where the public feed is centred, in words: the weather report's place
    // (it follows the punter, or a pinned spot), else your newest sighting.
    const centreLabel = weatherCentre ? (weatherPlace ?? 'the weather report’s spot') : 'your newest sighting';
    const publicItems = useMemo(() => pub.rows.map(itemFromPublic), [pub.rows]);

    useEffect(() => {
        try {
            localStorage.setItem(SIGHTINGS_SEEN_KEY, '1');
        } catch {
            /* a nicety */
        }
        void loadCatalogue().then(setCatalogue);
    }, []);

    const sheetOpen = logOpenedAt !== null || detail !== null || signIn;
    const signedIn = !!session.userId;
    const notPushed = mine.serverUnavailable || crew.unavailable || pub.unavailable;
    const waiting = mine.records.filter((r) => r.sync.state === 'pending').length;
    // Not sent, and not going to be on their own: say so at the top.
    const needPosition = mine.records.filter((r) => r.sync.state === 'needs-position').length;
    const refused = mine.records.filter((r) => r.sync.state === 'failed').length;
    const subtitle = boat
        ? boat.own
            ? `${boat.name ?? 'Your boat'}${session.ownCrewCount ? ` · ${session.ownCrewCount} crew` : ''}`
            : `${boat.name ?? 'Skipper’s boat'} · crew`
        : 'Whales, turtles, birds and fish';

    const openLog = () => setLogOpenedAt(Date.now());

    const signInCard = (what: string) => (
        <StateCard
            icon="me"
            title={`Sign in to see ${what}`}
            testId="sightings-signed-out"
            action={<SignInButton fullWidth onClick={() => setSignIn(true)} />}
        >
            Sightings you log now stay on this phone, private, until you sign in.
        </StateCard>
    );

    const notPushedCard = (
        <StateCard icon="lock" title="Sharing isn’t switched on yet" testId="sightings-not-pushed">
            Your sightings are saved on this phone and will share with the crew once it is. Nothing to do.
        </StateCard>
    );

    const emptyCard = (
        <StateCard icon="binoculars" title="No sightings yet" testId="sightings-empty">
            Next time something breaks the surface, tap Log a sighting.
        </StateCard>
    );

    // ── Crew ──
    const weekAgo = Date.now() - WEEK_MS;
    const crewWeek = crewItems.filter((i) => Date.parse(i.eventDate) >= weekAgo);
    const crewSpecies = new Set(crewWeek.map((i) => i.scientificName).filter(Boolean));
    const crewPanel = !signedIn ? (
        signInCard('your crew’s sightings')
    ) : !boat ? (
        <StateCard icon="crew" title="No boat yet" testId="sightings-no-boat">
            Crew sightings belong to a boat. Add your vessel, or accept a skipper’s invite in Crew &amp; Float Plan.
        </StateCard>
    ) : (
        <div className="space-y-3">
            {boats.length > 1 && (
                <Segmented
                    label="Whose boat"
                    value={String(boatIndex)}
                    onChange={(v) => setBoatIndex(Number(v))}
                    options={boats.map((b, i) => ({
                        value: String(i),
                        label: <span className="truncate">{b.name ?? (b.own ? 'My boat' : 'Skipper’s boat')}</span>,
                        name: b.name ?? (b.own ? 'My boat' : 'Skipper’s boat'),
                    }))}
                />
            )}
            {crew.unavailable && notPushedCard}
            <div className="sg-card grid grid-cols-2 p-3.5">
                <div>
                    <div className="sg-eyebrow">This week</div>
                    <div className="mt-0.5 text-[24px] font-black tabular-nums text-white">
                        {crewWeek.length}{' '}
                        <span className="text-[13px] font-bold sg-muted">
                            {crewWeek.length === 1 ? 'sighting' : 'sightings'}
                        </span>
                    </div>
                </div>
                <div>
                    <div className="sg-eyebrow">Species</div>
                    <div className="mt-0.5 text-[24px] font-black tabular-nums text-white">{crewSpecies.size}</div>
                </div>
            </div>
            <p className="flex items-center justify-end gap-1.5 px-1 text-[12px] font-bold sg-muted" role="status">
                {crew.fromCache || isOffline ? (
                    <>
                        <SightingIcon name="cloudOff" className="h-3.5 w-3.5" />
                        {crew.fetchedAt ? `Offline · crew feed from ${formatClock(crew.fetchedAt)}` : 'Offline'}
                    </>
                ) : crew.unavailable ? null : (
                    <>
                        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-400" />
                        Live from the crew
                    </>
                )}
            </p>
            {crewItems.length === 0 ? (
                emptyCard
            ) : (
                <DayGroupedList
                    items={crewItems}
                    render={(item) => (
                        <SightingRow
                            key={item.id}
                            item={item}
                            onOpen={setDetail}
                            byline={[
                                observerLabel(item, session.userId),
                                formatClock(item.eventDate),
                                formatPosition(item.latitude, item.longitude),
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                            note={
                                // Your own, not yet on the server: say so first.
                                item.syncState && item.syncState !== 'synced'
                                    ? SYNC_LABEL[item.syncState]
                                    : item.visibility === 'public'
                                      ? `Public 3 h later · blurred to ~${isCoarsePublic(catalogue, item.group, item.scientificName, !!item.local?.everSensitive) ? 8 : 1} km`
                                      : undefined
                            }
                        />
                    )}
                />
            )}
        </div>
    );

    // ── Public ──
    const publicWeek = publicItems.filter((i) => Date.parse(i.eventDate) >= weekAgo).length;
    const publicPanel = !signedIn ? (
        signInCard('public sightings')
    ) : (
        <div className="space-y-3">
            <p className="sg-card p-3.5 text-[13px] leading-snug sg-muted" data-testid="public-explainer">
                <b className="text-white">3 hours behind, on purpose.</b> Public sightings show here 3 hours after
                they’re logged, blurred to about 1 km, or 8 km for threatened species and any not yet named. No fish, no
                photos, and no log-handle credit on the 8 km grid.
            </p>
            {centre && (
                <p className="px-1 text-[12.5px] font-bold sg-muted" data-testid="public-centre">
                    Around {centreLabel}
                </p>
            )}
            <div className="flex items-center gap-2">
                <div role="group" aria-label="How far around" className="flex gap-1.5">
                    {RADII.map((r) => (
                        <button
                            key={r}
                            type="button"
                            aria-pressed={radius === r}
                            onClick={() => setRadius(r)}
                            className="sg-toggle sg-pill tabular-nums"
                        >
                            {r} km
                        </button>
                    ))}
                </div>
                <span className="ml-auto text-[12px] font-bold sg-muted">{publicWeek} this week</span>
            </div>
            {pub.unavailable ? (
                notPushedCard
            ) : isOffline ? (
                <StateCard icon="cloudOff" title="Public sightings need a connection">
                    Your own and your crew’s are in the other tabs.
                </StateCard>
            ) : !centre ? (
                <StateCard icon="pin" title="Waiting for a position">
                    Public sightings show around where you are.
                </StateCard>
            ) : pub.loading && publicItems.length === 0 ? (
                <p className="py-6 text-center text-sm sg-muted" role="status">
                    Looking around…
                </p>
            ) : publicItems.length === 0 ? (
                <StateCard icon="globe" title="Nothing public around here yet">
                    Sightings shared as Public appear here 3 hours after they’re logged.
                </StateCard>
            ) : (
                <ul className="sg-card sg-divider px-3">
                    {publicItems.map((item) => (
                        <SightingRow
                            key={item.id}
                            item={item}
                            onOpen={setDetail}
                            byline={`${item.observerDisplay} · ${agoLabel(item.eventDate)} · ${areaLabel(item.publicRow!.uncertainty_m)}`}
                        />
                    ))}
                </ul>
            )}
        </div>
    );

    // ── Mine ──
    // The boat's life list is all time from the server (the crew feed holds
    // 30 days), with the crew feed and this phone's own merged in by id.
    const species = useBoatSpecies(
        session.userId ? (boat?.ownerId ?? null) : null,
        tab === 'mine' && mineView === 'life' && lifeScope === 'boat',
    );
    const boatLifeRows = useMemo(() => {
        if (!boat) return [];
        const byId = new Map<string, Pick<SightingItem, 'scientificName' | 'group' | 'eventDate' | 'vernacularName'>>();
        for (const r of species.rows) {
            byId.set(r.id, {
                scientificName: r.scientific_name,
                group: r.taxon_group,
                eventDate: r.event_date,
                vernacularName: r.vernacular_name,
            });
        }
        for (const i of crewItems) byId.set(i.id, i);
        for (const i of myItems) if (i.vesselOwnerId === boat.ownerId) byId.set(i.id, i);
        return [...byId.values()];
    }, [boat, species.rows, crewItems, myItems]);
    const lifeRows = boat && lifeScope === 'boat' ? boatLifeRows : myItems;
    const lifeTitle = boat && lifeScope === 'boat' ? `${boat.name ?? 'The boat'}’s species` : 'My species';
    const lifeNote =
        boat && lifeScope === 'boat' && !species.complete && signedIn
            ? 'The crew’s last 30 days and this phone’s; all of it once online.'
            : undefined;
    const mapItems = [...myItems, ...crewItems.filter((c) => !myItems.some((m) => m.id === c.id))];

    const minePanel = (
        <div className="space-y-3">
            {signedIn && mine.signedOutCount > 0 && (
                <StateCard
                    icon="me"
                    title={`${mine.signedOutCount} logged while signed out`}
                    action={
                        <button
                            type="button"
                            onClick={() =>
                                void mine.adopt().then((n) => setAdoptNote(`${n} added to your account, Private.`))
                            }
                            className="min-h-[44px] rounded-full bg-emerald-700 px-4 text-[13.5px] font-extrabold text-white"
                        >
                            Add them to my account
                        </button>
                    }
                >
                    They are on this phone only. Add them to your account; they stay Private.
                </StateCard>
            )}
            {adoptNote && (
                <p className="px-1 text-[12.5px] font-bold text-emerald-300" role="status">
                    {adoptNote}
                </p>
            )}
            <Segmented
                label="Show my sightings as"
                value={mineView}
                onChange={setMineView}
                options={[
                    { value: 'list', label: 'List', name: 'List' },
                    { value: 'map', label: 'Map', name: 'Map' },
                    { value: 'life', label: 'Life list', name: 'Life list' },
                ]}
            />
            {!mine.loaded ? null : myItems.length === 0 && (mineView !== 'life' || !boat) ? (
                emptyCard
            ) : mineView === 'list' ? (
                <DayGroupedList
                    items={myItems}
                    render={(item) => (
                        <SightingRow
                            key={item.id}
                            item={item}
                            onOpen={setDetail}
                            byline={[
                                formatClock(item.eventDate),
                                formatPosition(item.latitude, item.longitude) ?? 'no position yet',
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                            note={
                                !signedIn
                                    ? 'On this phone · private'
                                    : item.syncState && item.syncState !== 'synced'
                                      ? SYNC_LABEL[item.syncState]
                                      : undefined
                            }
                            action={
                                item.syncState === 'needs-position' && isRecentForRetry(item.eventDate) ? (
                                    <RetryPositionButton id={item.id} signedIn={signedIn} />
                                ) : undefined
                            }
                        />
                    )}
                />
            ) : mineView === 'map' ? (
                <div className="h-[min(56dvh,460px)]">
                    {!sheetOpen && (
                        <Suspense fallback={<div className="h-full rounded-2xl sg-map" />}>
                            <SightingsMap
                                items={mapItems}
                                myUserId={session.userId}
                                onOpen={setDetail}
                                isOffline={isOffline}
                            />
                        </Suspense>
                    )}
                    <p className="mt-1.5 px-1 text-[12px] sg-muted">
                        Your sightings and the crew’s. Exact here, for you and your crew only.
                    </p>
                </div>
            ) : (
                <LifeList
                    title={lifeTitle}
                    rows={lifeRows}
                    note={lifeNote}
                    toggle={
                        boat ? (
                            <div role="group" aria-label="Whose species" className="sg-seg flex gap-0.5 p-0.5">
                                {(['boat', 'me'] as const).map((s) => (
                                    <button
                                        key={s}
                                        type="button"
                                        aria-pressed={lifeScope === s}
                                        onClick={() => setLifeScope(s)}
                                        className="sg-toggle min-h-[44px] min-w-[44px] rounded-[9px] px-2.5 text-[12.5px] font-extrabold"
                                    >
                                        {s === 'boat' ? 'Boat' : 'Me'}
                                    </button>
                                ))}
                            </div>
                        ) : undefined
                    }
                />
            )}
        </div>
    );

    const tabs: Array<{ id: Tab; label: string; icon: SightingIconName }> = [
        { id: 'crew', label: 'Crew', icon: 'crew' },
        { id: 'public', label: 'Public', icon: 'globe' },
        { id: 'mine', label: 'Mine', icon: 'me' },
    ];

    return (
        <div className="sg-surface flex h-full w-full flex-col" data-testid="sightings-page">
            <PageHeader
                title="Sightings"
                subtitle={subtitle}
                onBack={onBack}
                backLabel={backLabel}
                breadcrumbs={breadcrumbs}
            />
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(4rem+env(safe-area-inset-bottom)+16px)]">
                <div className="mx-auto w-full max-w-2xl space-y-3">
                    {(waiting > 0 || notPushed || needPosition > 0 || refused > 0) && (
                        <div className="space-y-2">
                            {waiting > 0 && !notPushed && (
                                <StateCard
                                    icon="cloudOff"
                                    title={`${isOffline ? 'Offline · ' : ''}${waiting} waiting to send`}
                                    testId="sightings-waiting"
                                >
                                    Saved on this phone. They go to the crew when a connection comes back.
                                </StateCard>
                            )}
                            {needPosition > 0 && (
                                <StateCard
                                    icon="pin"
                                    title={`${needPosition} ${needPosition === 1 ? 'needs' : 'need'} a position`}
                                    testId="sightings-needs-position"
                                    action={
                                        tab !== 'mine' ? (
                                            <button
                                                type="button"
                                                onClick={() => setTab('mine')}
                                                className="sg-toggle min-h-[44px] rounded-full px-4 text-[13.5px] font-extrabold"
                                            >
                                                Show me
                                            </button>
                                        ) : undefined
                                    }
                                >
                                    Not sent until {needPosition === 1 ? 'it has one' : 'they have one'}. Open it in
                                    Mine to add the boat’s position, or delete it.
                                </StateCard>
                            )}
                            {refused > 0 && (
                                <StateCard icon="cloudOff" title={`${refused} not sent`} testId="sightings-not-sent">
                                    The server didn’t accept {refused === 1 ? 'it' : 'them'}. Open it in Mine to see
                                    why.
                                </StateCard>
                            )}
                            {notPushed && tab === 'mine' && notPushedCard}
                        </div>
                    )}
                    <button type="button" onClick={openLog} className="sg-cta">
                        <BinocularsGlyph className="h-5 w-5" />
                        Log a sighting
                    </button>
                    <div role="tablist" aria-label="Sightings" className="sg-seg flex gap-1 p-1">
                        {tabs.map((t) => (
                            <button
                                key={t.id}
                                id={`sg-tab-${t.id}`}
                                type="button"
                                role="tab"
                                aria-selected={tab === t.id}
                                aria-controls={tab === t.id ? `sg-panel-${t.id}` : undefined}
                                tabIndex={tab === t.id ? 0 : -1}
                                onClick={() => setTab(t.id)}
                                onKeyDown={(e) => {
                                    const i = tabs.findIndex((x) => x.id === tab);
                                    if (e.key === 'ArrowRight') setTab(tabs[(i + 1) % tabs.length].id);
                                    if (e.key === 'ArrowLeft') setTab(tabs[(i + tabs.length - 1) % tabs.length].id);
                                }}
                                className="sg-toggle sg-seg-btn"
                            >
                                {t.id === 'crew' && signedIn && boat && !crew.unavailable && !isOffline ? (
                                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-400" />
                                ) : (
                                    <SightingIcon name={t.icon} className="h-4 w-4" />
                                )}
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <div id={`sg-panel-${tab}`} role="tabpanel" aria-labelledby={`sg-tab-${tab}`}>
                        {tab === 'crew' ? crewPanel : tab === 'public' ? publicPanel : minePanel}
                    </div>
                </div>
            </div>

            {logOpenedAt !== null && (
                <QuickLogSheet
                    openedAt={logOpenedAt}
                    onClose={() => setLogOpenedAt(null)}
                    onLogged={() => crew.refresh()}
                />
            )}
            {detail && (
                <SightingDetail item={detail} session={session} catalogue={catalogue} onClose={() => setDetail(null)} />
            )}
            {signIn && (
                <Suspense fallback={null}>
                    <SignInScreen
                        isOpen
                        onClose={() => setSignIn(false)}
                        prompt="Sign in to share sightings with your crew and see everyone’s."
                    />
                </Suspense>
            )}
        </div>
    );
};

export default SightingsPage;
