/**
 * What kind of official warning an alert is (129-06), read from each issuer's
 * own vocabulary, never from a guess at the text's meaning:
 *
 *   NWS     the VTEC phenomenon and significance (parameters.VTEC), else the
 *           NationalWeatherService or SAME event code (GLW, SCY, SMW), else
 *           the event name, in English or as NWS San Juan writes it in
 *           Spanish. A name NWS uses on land and at sea (Dense Fog, Dense
 *           Smoke, Ashfall) is marine when the code says so, else when it
 *           names a marine zone; a land one is never pushed.
 *   ECCC    the CAP-CP event code (profile:CAP-CP:Event), in either language
 *           block; a watch, advisory or statement by its headline.
 *   any CAP a tsunami in the Geo category, in the scripts its issuers use.
 *   MeteoAlarm  the issuer's own geographicDomain ("marine", MET Norway's sea
 *           areas), else an OASIS Event Term for the sea or the coast
 *           (OET-097 Hazardous Seas, OET-043 Coastal Flood), else the
 *           awareness type ("7; coastalevent", "14; marinehazard"); its
 *           strength from the awareness level: yellow is an advisory (Y),
 *           orange and red are warnings (W) (129-05b).
 *   JMA     the warning's own name (海上強風警報, 津波警報).
 *
 * The answer: where it applies (marine, coastal, land, or unknown), how
 * strong a product it is (the VTEC significance letters, used for every
 * issuer: W warning, A watch, Y advisory, S statement), and the hazards it
 * covers with a strength (129-07 suppresses a forecast alert an official
 * warning already covers). Pure and dependency-free: official-alerts-watch
 * decides its pushes with it, and the app's 129-07 predicate reads it.
 */

export type OfficialHazard = 'wind' | 'sea' | 'fog' | 'thunderstorm' | 'heat' | 'cold' | 'tsunami' | 'surge' | 'flood';
export type OfficialDomain = 'marine' | 'coastal' | 'land' | 'unknown';
export type Significance = 'W' | 'A' | 'Y' | 'S';
export type CapSeverity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
type Hazards = ReadonlyArray<readonly [OfficialHazard, number]>;

export interface OfficialEventClass {
    domain: OfficialDomain;
    significance: Significance;
    hazards: Hazards;
    tsunami: boolean;
}

export interface ClassifiableInfo {
    event: string;
    category?: readonly string[];
    headline?: string | null;
    parameters?: ReadonlyArray<{ valueName: string; value: string }>;
    eventCodes?: ReadonlyArray<{ valueName: string; value: string }>;
}

interface Kind {
    domain: OfficialDomain;
    hazards: Hazards;
}

const W1 = [['wind', 1]] as const;
const marine = (hazards: Hazards = []): Kind => ({ domain: 'marine', hazards });
const coastal = (hazards: Hazards = []): Kind => ({ domain: 'coastal', hazards });
const land = (hazards: Hazards = []): Kind => ({ domain: 'land', hazards });

/** NWS VTEC phenomena (the first two letters of a VTEC or NWS event code). */
const NWS_PHENOMENA: Record<string, Kind> = {
    SC: marine([
        ['wind', 1],
        ['sea', 1],
    ]),
    SI: marine(W1),
    SW: marine([['sea', 1]]),
    RB: marine([['sea', 1]]),
    BW: marine(W1),
    GL: marine([['wind', 2]]),
    SR: marine([['wind', 3]]),
    HF: marine([['wind', 4]]),
    SE: marine([['sea', 2]]),
    UP: marine([['cold', 2]]),
    ZY: marine([['cold', 1]]),
    MF: marine([['fog', 2]]),
    MS: marine([['fog', 1]]),
    MH: marine(),
    LO: marine(),
    MA: marine([
        ['thunderstorm', 2],
        ['wind', 2],
    ]),
    SU: coastal([['sea', 2]]),
    RP: coastal(),
    BH: coastal(),
    CF: coastal([['flood', 1]]),
    LS: coastal([['flood', 1]]),
    SS: coastal([['surge', 2]]),
    TS: coastal([['tsunami', 3]]),
    TR: coastal([['wind', 2]]),
    HU: coastal([['wind', 4]]),
    TY: coastal([['wind', 4]]),
    // Land types: in the app only, and still read for 129-07's cover.
    WI: land(W1),
    HW: land([['wind', 2]]),
    EW: land([['wind', 4]]),
    FG: land([['fog', 2]]),
    SV: land([['thunderstorm', 2]]),
    TO: land(),
    HT: land([['heat', 2]]),
    EH: land([['heat', 3]]),
    XH: land([['heat', 3]]),
    FZ: land([['cold', 1]]),
    HZ: land([['cold', 1]]),
    FR: land([['cold', 1]]),
    WS: land(),
    BZ: land(),
    WW: land(),
    FF: land(),
    FA: land(),
    FL: land(),
    // Smoke and ash on land (NWS writes marine ones as MS and MH).
    SM: land(),
    AF: land(),
};

/** NWS three-letter event codes that are not phenomenon + significance. */
const NWS_CODES: Record<string, [string, Significance]> = {
    SMW: ['MA', 'W'],
    MWS: ['MA', 'S'],
    HLS: ['HU', 'S'],
    TOR: ['TO', 'W'],
    SVR: ['SV', 'W'],
    FFW: ['FF', 'W'],
};

/** Names, for an alert with no code: [pattern, phenomenon, significance or null to read it from the name]. */
const NWS_NAMES: ReadonlyArray<readonly [RegExp, string, Significance | null]> = [
    [/special marine warning|aviso marino especial/, 'MA', 'W'],
    [/marine weather statement/, 'MA', 'S'],
    [/small craft|embarcaciones peque/, 'SC', null],
    [/brisk wind/, 'BW', null],
    [/hurricane force wind/, 'HF', null],
    [/tropical storm|tormenta tropical/, 'TR', null],
    [/hurricane|hurac[aá]n/, 'HU', null],
    [/typhoon|tif[oó]n/, 'TY', null],
    [/storm surge|marejada cicl/, 'SS', null],
    [/\bgale\b|galerna|vientos de galera/, 'GL', null],
    [/^(?:marine |)storm (?:warning|watch)/, 'SR', null],
    [/hazardous seas|mares peligrosos/, 'SE', null],
    [/heavy freezing spray/, 'UP', null],
    [/freezing spray/, 'ZY', null],
    [/low water/, 'LO', null],
    [/high surf|oleaje alto|marejadas/, 'SU', null],
    [/rip current|corrientes? (?:de resaca|marinas)/, 'RP', 'S'],
    [/beach hazards/, 'BH', 'S'],
    [/coastal flood|inundaciones costeras/, 'CF', null],
    [/lakeshore flood/, 'LS', null],
    [/tornado/, 'TO', null],
    [/severe thunderstorm/, 'SV', null],
    [/excessive heat|extreme heat/, 'EH', null],
    [/heat advisory/, 'HT', null],
    [/high wind/, 'HW', null],
    [/wind advisory/, 'WI', null],
    [/winter storm|blizzard|ice storm|snow|winter weather/, 'WS', null],
    [/freeze|frost/, 'FZ', null],
    [/flood/, 'FL', null],
];

/**
 * NWS marine zones: the UGC "state" letters of coastal, offshore and Great
 * Lakes waters. The held migration 20261014160000 (and 129-05's
 * official_alerts_at) matches the same letters to reach the water outside a
 * berth (tests/OfficialAlertsWatchMigration.test.ts holds them equal).
 */
export const NWS_MARINE_ZONE_AREAS = [
    'AM',
    'AN',
    'GM',
    'PZ',
    'PK',
    'PH',
    'PM',
    'PS',
    'LM',
    'LS',
    'LH',
    'LO',
    'LE',
    'LC',
    'SL',
];
const NWS_MARINE_ZONE = new RegExp(`^nws:[a-z]+:(?:${NWS_MARINE_ZONE_AREAS.join('|')})Z\\d{3}$`);

/**
 * Names NWS gives a product on land and at sea alike: [pattern, the marine
 * phenomenon, the land one, the significance when the name says none]. Marine
 * only when the alert names a marine zone: a land Dense Smoke Advisory or
 * Ashfall Warning is never pushed as a marine one.
 */
const NWS_SHARED_NAMES: ReadonlyArray<readonly [RegExp, string, string, Significance]> = [
    [/dense fog/, 'MF', 'FG', 'Y'],
    [/dense smoke/, 'MS', 'SM', 'Y'],
    [/ashfall/, 'MH', 'AF', 'Y'],
];

const TSUNAMI = /tsunami|tsunamis|津波|海啸|海嘯|쓰나미|지진해일|τσουνάμι|цунами|تسونامي|צונאמי|सुनामी|สึนามิ|sóng thần/;
const TSUNAMI_NOT_A_WARNING = /statement|information|cancel|no threat|all clear/;

/** ECCC's CAP-CP event codes. */
const ECCC_EVENTS: Record<string, Kind> = {
    gale: marine([['wind', 2]]),
    storm: marine([['wind', 3]]),
    hurricFrcWnd: marine([['wind', 4]]),
    squall: marine([
        ['wind', 2],
        ['thunderstorm', 1],
    ]),
    freezgSpray: marine([['cold', 2]]),
    freezingSpray: marine([['cold', 2]]),
    waterspout: marine([['thunderstorm', 1]]),
    highWater: coastal([['flood', 1]]),
    stormSurge: coastal([['surge', 2]]),
    tsunami: coastal([['tsunami', 3]]),
    hurricane: coastal([['wind', 4]]),
    tropStorm: coastal([['wind', 2]]),
    wind: land(W1),
    fog: land([['fog', 2]]),
    thunderstorm: land([['thunderstorm', 2]]),
    heat: land([['heat', 2]]),
    coldWave: land([['cold', 1]]),
    frost: land([['cold', 1]]),
    rainfall: land(),
    snowfall: land(),
    snowSquall: land(),
    blizzard: land(),
    winterStorm: land(),
    blowingSnow: land(),
    freezgRain: land(),
    freezgDrzl: land(),
    tornado: land(),
    dustStorm: land(),
    airQual: land(),
    flood: land(),
    flashFlood: land(),
    weather: land(),
};

/**
 * MeteoAlarm awareness types (the Style Guide's list): a coastal event (7) and
 * a marine hazard (14) are at the coast and at sea; every other type is land.
 */
const METEOALARM_TYPES: Record<string, Kind> = {
    '1': land(W1),
    '3': land([['thunderstorm', 2]]),
    '4': land([['fog', 2]]),
    '5': land([['heat', 2]]),
    '6': land([['cold', 1]]),
    '7': coastal([['sea', 2]]),
    '14': marine([['sea', 2]]),
};

/** OASIS Event Terms (the eventCode OET:v1.0 MeteoAlarm's profile carries) for the sea and the coast. */
const OET_SEA: Record<string, Kind> = {
    'OET-043': coastal([['flood', 1]]), // Coastal Flood
    'OET-091': marine([['cold', 2]]), // Freezing Spray
    'OET-097': marine([['sea', 2]]), // Hazardous Seas
    'OET-101': marine([['sea', 2]]), // High Seas
    'OET-102': coastal([['sea', 2]]), // High Surf
    'OET-103': coastal([['flood', 1]]), // High Tide
    'OET-191': coastal([['surge', 2]]), // Storm Surge
    'OET-198': marine([['thunderstorm', 1]]), // Tornadic Waterspout
    'OET-218': marine([['thunderstorm', 1]]), // Waterspout
};

/** A MeteoAlarm warning's class: the issuer's word for the sea, else a sea term, else its awareness type. */
function fromMeteoAlarm(info: ClassifiableInfo): [Kind, Significance] | null {
    const type = /^\s*(\d+)/.exec(value(info.parameters, /^awareness_type$/i) ?? '')?.[1];
    const oet = (info.eventCodes ?? []).map((c) => OET_SEA[c.value.trim()]).find(Boolean);
    let kind: Kind | null = oet ?? (type ? (METEOALARM_TYPES[type] ?? land()) : null);
    if (!kind) return null;
    if (/^marine$/i.test(value(info.parameters, /^geographicDomain$/i) ?? '') && kind.domain === 'land') {
        // Its hazards at sea: a wind warning for a sea area is a gale or more (MET Norway's kuling).
        kind = marine(kind.hazards.map(([h, n]) => [h, h === 'wind' ? Math.max(n, 2) : n] as const));
    }
    // Yellow (2) is "be aware": an advisory. Orange (3) and red (4) are warnings.
    const level = /^\s*(\d+)/.exec(value(info.parameters, /^awareness_level$/i) ?? '')?.[1];
    return [kind, level === '2' || level === '1' ? 'Y' : 'W'];
}

/** JMA's names: 海上 (at sea) warnings, and the coast's storm surge and high waves. */
const JMA_NAMES: ReadonlyArray<readonly [RegExp, Kind]> = [
    [/^海上(?:暴風|台風)/, marine([['wind', 3]])],
    [/^海上強風/, marine([['wind', 2]])],
    [/^海上風/, marine(W1)],
    [/^海上濃霧/, marine([['fog', 2]])],
    [/^海上(?:着氷|うねり)/, marine([['sea', 1]])],
    [/高潮/, coastal([['surge', 2]])],
    [/波浪/, coastal([['sea', 2]])],
];

const value = (list: ClassifiableInfo['parameters'], name: RegExp): string | null =>
    list?.find((v) => name.test(v.valueName))?.value?.trim() || null;

/** W, A, Y or S from the words of a name or headline, in English, Spanish, French or Japanese. */
function significanceFrom(text: string, fallback: Significance = 'W'): Significance {
    if (/statement|declaraci|bulletin|déclaration|情報/.test(text)) return 'S';
    if (/\bwatch\b|vigilancia|veille/.test(text)) return 'A';
    if (/advisory|advertencia|avis\b|注意報/.test(text)) return 'Y';
    if (/warning|aviso|avertissement|alerte|警報/.test(text)) return 'W';
    return fallback;
}

function fromNws(info: ClassifiableInfo, zones: readonly string[], name: string): [Kind, Significance] | null {
    const vtec = /\/[OTEX]\.[A-Z]{3}\.[A-Z]{4}\.([A-Z]{2})\.([WAYS])\./.exec(value(info.parameters, /^VTEC$/i) ?? '');
    if (vtec && NWS_PHENOMENA[vtec[1]]) return [NWS_PHENOMENA[vtec[1]], vtec[2] as Significance];
    for (
        const code of [
            value(info.eventCodes, /^NationalWeatherService$/i),
            value(info.eventCodes, /^SAME$/i),
        ]
    ) {
        if (!code) continue;
        const special = NWS_CODES[code];
        if (special) return [NWS_PHENOMENA[special[0]], special[1]];
        const m = /^([A-Z]{2})([WAYS])$/.exec(code);
        if (m && NWS_PHENOMENA[m[1]]) return [NWS_PHENOMENA[m[1]], m[2] as Significance];
    }
    const shared = NWS_SHARED_NAMES.find(([pattern]) => pattern.test(name));
    if (shared) {
        const atSea = zones.some((z) => NWS_MARINE_ZONE.test(z));
        return [NWS_PHENOMENA[atSea ? shared[1] : shared[2]], significanceFrom(name, shared[3])];
    }
    const hit = NWS_NAMES.find(([pattern]) => pattern.test(name));
    return hit ? [NWS_PHENOMENA[hit[1]], hit[2] ?? significanceFrom(name)] : null;
}

/**
 * The class of one info block. `provider` is the provider row's id ("nws",
 * "eccc", "jma", "meteoalarm-gr", or a generic CAP feed's); `zones` the
 * alert's zone keys, which tell NWS's marine fog from its land fog.
 */
export function classifyOfficialEvent(
    provider: string,
    info: ClassifiableInfo,
    zones: readonly string[] = [],
): OfficialEventClass {
    const name = (info.event ?? '').trim().toLowerCase();
    const said = `${name} ${(info.headline ?? '').toLowerCase()}`;
    const geo = (info.category ?? []).some((c) => /^geo$/i.test(c));
    let found: [Kind, Significance] | null = null;
    if (provider === 'nws') {
        found = fromNws(info, zones, name);
    } else if (provider === 'eccc') {
        const code = value(info.eventCodes, /^profile:CAP-CP:Event/i);
        const kind = code ? ECCC_EVENTS[code] : undefined;
        if (kind) found = [kind, significanceFrom(said)];
    } else if (provider.startsWith('meteoalarm')) {
        found = fromMeteoAlarm(info);
    } else if (provider === 'jma') {
        const hit = JMA_NAMES.find(([pattern]) => pattern.test(info.event));
        if (hit) found = [hit[1], significanceFrom(info.event)];
        else if (/(?:警報|注意報)$/.test(info.event) && !TSUNAMI.test(info.event)) {
            found = [land(), significanceFrom(info.event)];
        }
    }
    // A tsunami, from any issuer that names it: CAP files it under Geo (NWS
    // and ECCC under their own codes too). Never an information statement.
    const tsunamiNamed = TSUNAMI.test(said) && !TSUNAMI_NOT_A_WARNING.test(said);
    if (tsunamiNamed && (geo || !found || found[0].hazards.some(([h]) => h === 'tsunami'))) {
        return { domain: 'coastal', significance: significanceFrom(said), hazards: [['tsunami', 3]], tsunami: true };
    }
    if (!found) return { domain: 'unknown', significance: significanceFrom(said, 'S'), hazards: [], tsunami: false };
    const [kind, significance] = found;
    return {
        domain: kind.domain,
        significance,
        hazards: kind.hazards,
        tsunami: kind.hazards.some(([h]) => h === 'tsunami'),
    };
}

const SEVERITY_RANK: Record<CapSeverity, number> = { Unknown: 0, Minor: 1, Moderate: 2, Severe: 3, Extreme: 4 };

export function capSeverity(s: unknown): CapSeverity {
    return typeof s === 'string' && s in SEVERITY_RANK ? (s as CapSeverity) : 'Unknown';
}

export function severityRank(s: unknown): number {
    return SEVERITY_RANK[capSeverity(s)];
}

/**
 * Whether a warning may push at the boat, and how (decision B, 14 Oct):
 *   - marine and coastal only; land types, statements and unknown events are
 *     in the app only;
 *   - a tsunami always as Extreme, whatever the feed said;
 *   - a marine or coastal warning (gale, storm, hurricane-force, special
 *     marine, storm surge, coastal flood) at least Severe: it goes at once;
 *   - otherwise the feed's own severity: Severe and Extreme at once and Time
 *     Sensitive, Moderate and Minor (a Small Craft Advisory, a watch) as an
 *     advisory that waits out quiet hours and that its switch can mute.
 */
export function officialPushClass(
    cls: OfficialEventClass,
    severity: string,
): { push: boolean; urgent: boolean; severity: CapSeverity } {
    let sev = capSeverity(severity);
    if (cls.tsunami) return { push: true, urgent: true, severity: 'Extreme' };
    if ((cls.domain !== 'marine' && cls.domain !== 'coastal') || cls.significance === 'S') {
        return { push: false, urgent: false, severity: sev };
    }
    if (cls.significance === 'W' && SEVERITY_RANK[sev] < SEVERITY_RANK.Severe) sev = 'Severe';
    return { push: true, urgent: SEVERITY_RANK[sev] >= SEVERITY_RANK.Severe, severity: sev };
}
