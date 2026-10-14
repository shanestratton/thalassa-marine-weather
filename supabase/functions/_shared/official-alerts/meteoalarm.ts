/**
 * MeteoAlarm under its own terms (129-05b): what the ingest, the push and the
 * app's Warnings page all need to say. Pure and dependency-free, so the app
 * imports it too (components/warnings/OfficialWarningsSection.tsx).
 *
 * MeteoAlarm's Terms and Conditions, section 5
 * (https://meteoalarm.org/en/live/page/terms-and-conditions, last updated
 * 15/03/2024, read 2026-10-14): the warnings may be redistributed under terms
 * equivalent to CC BY 4.0, and:
 *   1. modified information goes with the unmodified original (Thalassa never
 *      modifies it: the issuer's words are shown verbatim);
 *   2. the source is "EUMETNET – MeteoAlarm" when what is shown spans more
 *      than one country, and the national service's name when it is one;
 *   3. the time of issue is included;
 *   4. internet applications link to www.meteoalarm.org;
 *   5. the delay averages under 5 minutes and is never over 10 (ingest.ts reads
 *      every MeteoAlarm feed on every 5-minute run);
 *   6. the disclaimer below is published verbatim.
 * The Style Guide v1.0 (February 2026, from the Redistribution Hub) adds how a
 * warning is shown: a title of its awareness level and type ("Yellow Wind
 * Warning"), the participant's name as its source, onset and expiry with time
 * zones, its area, its description and instruction in every language sent,
 * English where the reader's is not sent, and the text never altered.
 */

/** Rule 4's link, as the Terms and Conditions give it. */
export const METEOALARM_LINK = 'https://meteoalarm.org/en/live/';
export const METEOALARM_LINK_TEXT = 'www.meteoalarm.org';
/** Rule 6, verbatim (the Terms and Conditions and the Redistribution Guide v1.0 agree, word for word). */
export const METEOALARM_DISCLAIMER =
    'Time delays between this website and the www.meteoalarm.org website are possible. For the most up-to-date awareness information as published by the participating National Meteorological and Hydrological Services, please refer to www.meteoalarm.org.';
/** Rule 2's source when more than one country is shown (an en dash). */
export const METEOALARM_SOURCE = 'EUMETNET – MeteoAlarm';

export const isMeteoAlarm = (provider: string): boolean => provider.startsWith('meteoalarm-');

/**
 * Each member country's participants, as MeteoAlarm's "Our Warning Providers"
 * page names them (read 2026-10-14). The held migration seeds each provider's
 * issuer as these names joined by " / ", then " (MeteoAlarm)".
 */
export const METEOALARM_PARTICIPANTS: Readonly<Record<string, readonly string[]>> = {
    ad: ['Servei Meteorològic Nacional (SMN)'],
    at: ['GeoSphere Austria'],
    be: ['Institut Royal Météorologique/Koninklijk Meteorologisch Instituut (IRM/KMI)'],
    ba: [
        'Federalni Hidrometeorološki Zavod BiH (FHMZ)',
        'Republički Hidrometeorološki Zavod Republike Srpske (RHMZ RS)',
    ],
    bg: ['National Institute of Meteorology and Hydrology (NIMH)'],
    hr: ['Državni Hidrometeorološki Zavod (DHMZ)'],
    cy: ['Cyprus Department of Meteorology (CYMET)'],
    cz: ['Czech Hydrometeorological Institute (CHMI)'],
    dk: ['Danmarks Meteorologiske Institut (DMI)'],
    ee: ['Estonian Environment Agency (ESTEA)'],
    fi: ['Finnish Meteorological Institute (FMI)'],
    fr: ['Météo-France'],
    de: ['Deutscher Wetterdienst (DWD)'],
    gr: ['Hellenic National Meteorological Service (HNMS)'],
    hu: ['HungaroMet'],
    is: ['Icelandic Meteorological Office (IMO)'],
    ie: ['Met Éireann'],
    il: ['Israel Meteorological Service (IMS)'],
    it: ['Servizio Meteorologico dell’Aeronautica Militare (MeteoAM)'],
    lv: ['Latvijas Vides, Ģeoloģijas un Meteoroloģijas Centrs (LVĢMC)'],
    lt: ['Lietuvos Hidrometeorologijos Tarnyba (LHMT)'],
    lu: ['MeteoLux'],
    mt: ['Malta Meteorological Office (MAMO)'],
    md: ['Autoritatea de Meteorologie și Monitoring de Mediu (AMM)'],
    me: ['Zavod za Hidrometeorologiju i Seizmologiju (ZHMS)'],
    nl: ['Koninklijk Nederlands Meteorologisch Instituut (KNMI)'],
    mk: ['Hydrometeorological Service of Republic of North Macedonia (HMS)'],
    no: ['Meteorologisk Institutt (MET Norway)', 'Norges Vassdrags- og Energidirektorat (NVE)'],
    pl: ['Instytut Meteorologii i Gospodarki Wodnej - Państwowy Instytut Badawczy (IMGW-PIB)'],
    pt: ['Instituto Português do Mar e da Atmosfera (IPMA)'],
    ro: ['Administrația Națională de Meteorologie (ANM)'],
    rs: ['Republički Hidrometeorološki Zavod Srbije (RHMZ)'],
    sk: ['Slovenský Hydrometeorologický Ústav (SHMÚ)'],
    si: ['Agencija Republike Slovenije za Okolje (ARSO)'],
    es: ['Agencia Estatal de Meteorología (AEMET)'],
    se: ['Sveriges Meteorologiska och Hydrologiska Institut (SMHI)'],
    ch: ['Federal Office of Meteorology and Climatology MeteoSwiss'],
    ua: ['Ukrainian Hydrometeorological Center (UHMC)'],
    gb: [
        'Met Office',
        'Environment Agency (EA)',
        'Natural Resources Wales (NRW)',
        'Scottish Environment Protection Agency (SEPA)',
    ],
};

/** The seeded issuer's ending: "Météo-France (MeteoAlarm)". */
export const METEOALARM_ISSUER_SUFFIX = ' (MeteoAlarm)';

/** Every participant of the provider's country, by name. */
export const meteoAlarmParticipants = (provider: string): string[] => [
    ...(METEOALARM_PARTICIPANTS[provider.slice('meteoalarm-'.length)] ?? []),
];

/** The participants a seeded issuer names ("Met Office / Environment Agency (EA) / ... (MeteoAlarm)"). */
export const meteoAlarmIssuerNames = (issuer: string): string[] =>
    issuer.replace(METEOALARM_ISSUER_SUFFIX, '').split(' / ').filter(Boolean);

/** Letters only, without accents: "Météo-France" is "meteofrance", "rhmzrs.com" is "rhmzrscom". */
const letters = (s: string) =>
    s
        .normalize('NFD')
        .toLowerCase()
        .replace(/[^a-z]/g, '');

/**
 * Which of a country's participants a warning is from (rule 2, the Style
 * Guide's source): the one participant, else the one whose name or the
 * short name in its brackets the CAP sender or senderName spells
 * (metoffice.gov.uk, sinoptika@rhmzrs.com, "MET Norway"), else the issuer's
 * own senderName.
 */
export function meteoAlarmParticipant(
    names: readonly string[],
    sender?: string | null,
    senderName?: string | null,
): string {
    if (names.length === 1) return names[0];
    const said = letters(`${sender ?? ''} ${senderName ?? ''}`);
    const hit = names.find((name) => {
        const short = /\(([^)]+)\)\s*$/.exec(name)?.[1] ?? '';
        return [letters(name.replace(/\s*\([^)]*\)\s*$/, '')), letters(short)].some(
            (key) => key.length >= 3 && said.includes(key),
        );
    });
    return hit ?? (senderName?.trim() || names.join(' / ') || METEOALARM_SOURCE);
}

/** The national service a warning from this provider is from (the push; the app reads the issuer it was given). */
export const meteoAlarmSource = (provider: string, sender?: string | null, senderName?: string | null): string =>
    meteoAlarmParticipant(meteoAlarmParticipants(provider), sender, senderName);

/** How many MeteoAlarm countries these provider ids span: above one, the source is METEOALARM_SOURCE. */
export const meteoAlarmCountries = (providers: readonly string[]): number =>
    new Set(providers.filter(isMeteoAlarm)).size;

type Values = ReadonlyArray<{ valueName: string; value: string }> | undefined;
const LEVELS = ['', '', 'Yellow', 'Orange', 'Red'];
/** The Style Guide's colour for each awareness level (Moderate, Severe, Extreme). */
export const METEOALARM_COLOURS = ['', '', '#ffda22', '#ff9300', '#ff0000'];
const TYPES = [
    '',
    'Wind',
    'Snow or Ice',
    'Thunderstorm',
    'Fog',
    'High Temperature',
    'Low Temperature',
    'Coastal Event',
    'Forest Fire',
    'Avalanche',
    'Rain',
    '',
    'Flood',
    'Rain Flood',
    'Marine Hazard',
    'Drought',
];

/** The number before the first ";" of a parameter ("3; orange; Severe" is 3), or null. */
export function meteoAlarmNumber(parameters: Values, name: string): number | null {
    const v = parameters?.find((p) => p.valueName.toLowerCase() === name)?.value;
    const m = v ? /^\s*(\d+)/.exec(v) : null;
    return m ? Number(m[1]) : null;
}

/** The awareness level (2 yellow, 3 orange, 4 red), or null. */
export const meteoAlarmLevel = (parameters: Values): number | null => {
    const level = meteoAlarmNumber(parameters, 'awareness_level');
    return level !== null && LEVELS[level] ? level : null;
};

/** The Style Guide's title, "[level] [type] Warning" ("Orange Coastal Event Warning"), or null. */
export function meteoAlarmTitle(parameters: Values): string | null {
    const level = meteoAlarmLevel(parameters);
    const type = TYPES[meteoAlarmNumber(parameters, 'awareness_type') ?? 0];
    return level !== null && type ? `${LEVELS[level]} ${type} Warning` : null;
}
