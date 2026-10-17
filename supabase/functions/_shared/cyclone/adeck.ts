/**
 * ATCF a-deck tracks (129-09): every model's forecast track for every storm,
 * from NCEP's GFS tracker file (gfs.tCCz.atcfunix.all, every basin) and NHC's
 * public a-decks (ftp.nhc.noaa.gov/atcf/aid_public, AL/EP/CP only). Pure:
 * fetch-gfs-tracker does the fetching.
 *
 * A-deck columns: BASIN, CY, YYYYMMDDHH, TECHNUM, TECH, TAU, LatN/S, LonE/W,
 * VMAX, MSLP, … Positions are tenths of a degree with a hemisphere letter, and
 * the spelling differs by basin: the Atlantic and East Pacific write west
 * longitudes, the West Pacific east and then west over the antimeridian, the
 * southern hemisphere south latitudes. One line per wind radius, so a tau can
 * repeat; one point per tau is kept.
 *
 * Storms are keyed by basin and number ("SH05") without the year: a southern
 * season's storms carry the next year's number from July, which no line says.
 */

export interface AdeckPoint {
    tau: number;
    lat: number;
    lon: number;
    vmax: number | null;
}

export interface AdeckTrack {
    storm: string;
    basin: string;
    tech: string;
    /** YYYYMMDDHH */
    cycle: string;
    points: AdeckPoint[];
}

export type TechKind = 'official' | 'advisory' | 'model' | 'consensus';

export interface TechInfo {
    label: string;
    /** The producer credited under the line (a licence condition, not a courtesy). */
    by: string;
    kind: TechKind;
}

function position(raw: string, letters: string, max: number): number | null {
    const m = /^(\d{1,4})([A-Z])$/.exec(raw.trim().toUpperCase());
    if (!m || !letters.includes(m[2])) return null;
    const v = +m[1] / 10;
    if (v > max) return null;
    return m[2] === letters[1] ? -v : v;
}

/** "214S" → -21.4 */
export const atcfLat = (raw: string): number | null => position(raw, 'NS', 90);
/** "1795W" → -179.5 */
export const atcfLon = (raw: string): number | null => position(raw, 'EW', 180);

/** "2026101306" → "2026-10-13T06:00:00.000Z" */
export function cycleIso(cycle: string): string | null {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(cycle);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
    const d = new Date(t);
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[4] < 24 ? d.toISOString() : null;
}

/** A warning centre's storm id suffix ("28P") to the ATCF basin. */
const SUFFIX_BASIN: Record<string, string> = { L: 'AL', E: 'EP', C: 'CP', W: 'WP', A: 'IO', B: 'IO', S: 'SH', P: 'SH' };

/** The latest cycle of each storm and tech, with forecast taus only (0-168 h). */
export function parseAdeck(text: string, opts: { sinceCycle?: string } = {}): AdeckTrack[] {
    const tracks = new Map<string, AdeckTrack>();
    for (const line of text.split('\n')) {
        const col = line.split(',').map((s) => s.trim());
        if (col.length < 9) continue;
        let [basin, cy] = col;
        const [, , cycle, , tech, tauRaw, latRaw, lonRaw, vmaxRaw] = col;
        // Some tracker files lead with the centre and its id ("JTWC, 28P").
        const id = /^(\d{1,2})([A-Z])$/.exec(cy);
        if (id && SUFFIX_BASIN[id[2]]) [basin, cy] = [SUFFIX_BASIN[id[2]], id[1]];
        if (!/^[A-Z]{2}$/.test(basin) || !/^\d{1,2}$/.test(cy) || !/^\d{10}$/.test(cycle) || !tech) continue;
        if (opts.sinceCycle && cycle < opts.sinceCycle) continue;
        const tau = Number(tauRaw);
        const lat = atcfLat(latRaw);
        const lon = atcfLon(lonRaw);
        if (!Number.isInteger(tau) || tau < 0 || tau > 168 || lat === null || lon === null) continue;
        if (lat === 0 && lon === 0) continue;
        const storm = `${basin}${cy.padStart(2, '0')}`;
        const key = `${storm}|${tech}`;
        let t = tracks.get(key);
        if (t && cycle < t.cycle) continue;
        if (!t || cycle > t.cycle) {
            t = { storm, basin, tech, cycle, points: [] };
            tracks.set(key, t);
        }
        if (t.points.some((p) => p.tau === tau)) continue;
        const vmax = Number(vmaxRaw);
        t.points.push({ tau, lat, lon, vmax: Number.isFinite(vmax) && vmax > 0 ? vmax : null });
    }
    for (const t of tracks.values()) t.points.sort((a, b) => a.tau - b.tau);
    return [...tracks.values()];
}

/**
 * The techs Thalassa draws, in order of preference within a label (the
 * full-resolution run before its interpolated "I" copy). Anything else is not
 * drawn: an aid whose producer cannot be named cannot be credited; statistical
 * and climatology aids (CLIPER, XTRP, BAM, LBAR, SHIPS) are not forecasts of
 * this storm; and thirty ensemble members are spaghetti, so only the means.
 */
const CATALOGUE: [string[], string, string, TechKind][] = [
    [['OFCL', 'OFCI'], 'NHC official', 'NOAA NHC', 'official'],
    [['JTWC'], 'JTWC', 'JTWC', 'advisory'],
    [['AVNO', 'AVNI', 'GFSO', 'GFSI'], 'GFS', 'NOAA NCEP', 'model'],
    [['EMX', 'EMXI', 'EMX2'], 'ECMWF', 'ECMWF', 'model'],
    [['UKX', 'UKXI', 'UKX2', 'EGRR', 'EGRI', 'UKM', 'UKMI'], 'UKMO', 'Met Office', 'model'],
    [['CMC', 'CMCI', 'CMC2'], 'CMC', 'Environment Canada', 'model'],
    [['NVGM', 'NVGI'], 'NAVGEM', 'US Navy FNMOC', 'model'],
    [['JGSM', 'JGSI'], 'JMA GSM', 'JMA', 'model'],
    [['HWRF', 'HWFI'], 'HWRF', 'NOAA NCEP', 'model'],
    [['HMON', 'HMNI'], 'HMON', 'NOAA NCEP', 'model'],
    [['HAFA', 'HFAI'], 'HAFS-A', 'NOAA NCEP', 'model'],
    [['HAFB', 'HFBI'], 'HAFS-B', 'NOAA NCEP', 'model'],
    [['CTCX', 'CTCI'], 'COAMPS-TC', 'US Navy NRL', 'model'],
    [['AEMN', 'AEMI'], 'GEFS mean', 'NOAA NCEP', 'model'],
    [['EEMN', 'EMNI'], 'ECMWF ens. mean', 'ECMWF', 'model'],
    [['UEMN', 'UEMI'], 'UKMO ens. mean', 'Met Office', 'model'],
    [['TVCN', 'TVCA', 'TVCE', 'TVCX'], 'Consensus', 'NOAA NHC', 'consensus'],
    [['HCCA'], 'HCCA', 'NOAA NHC', 'consensus'],
];

const RANK = new Map<string, number>();
const INFO = new Map<string, TechInfo>();
for (const [techs, label, by, kind] of CATALOGUE) {
    techs.forEach((tech, i) => {
        RANK.set(tech, i);
        INFO.set(tech, { label, by, kind });
    });
}

export function techInfo(tech: string): TechInfo | null {
    const info = INFO.get(tech.toUpperCase());
    return info ? { ...info } : null;
}

export interface ModelTrack {
    storm: string;
    tech: string;
    label: string;
    by: string;
    kind: 'model' | 'consensus';
    /** The run's synoptic time, ISO. */
    cycle: string;
    /** [tau h, lat, lon, vmax kt] */
    points: [number, number, number, number | null][];
}

/**
 * One line per model per storm: the newest cycle among a model's techs (the
 * interpolated copy of the last run is newer than the run itself), the
 * full-resolution tech on a tie. Runs more than 36 h old are dropped. The
 * official and JTWC tracks are not here: the storm layer draws them from the
 * feed that also carries their advisory.
 */
export function modelTracks(tracks: AdeckTrack[], nowMs: number): ModelTrack[] {
    const best = new Map<string, { track: AdeckTrack; info: TechInfo }>();
    for (const track of tracks) {
        const info = INFO.get(track.tech);
        const iso = cycleIso(track.cycle);
        if (!info || (info.kind !== 'model' && info.kind !== 'consensus') || !iso) continue;
        if (track.points.length < 2 || nowMs - Date.parse(iso) > 36 * 3_600_000) continue;
        const id = `${track.storm}|${info.label}`;
        const held = best.get(id);
        if (
            held &&
            (held.track.cycle > track.cycle ||
                (held.track.cycle === track.cycle && RANK.get(held.track.tech)! <= RANK.get(track.tech)!))
        ) {
            continue;
        }
        best.set(id, { track, info });
    }
    return [...best.values()].map(({ track, info }) => ({
        storm: track.storm,
        tech: track.tech,
        label: info.label,
        by: info.by,
        kind: info.kind as 'model' | 'consensus',
        cycle: cycleIso(track.cycle)!,
        points: track.points.map((p) => [p.tau, p.lat, p.lon, p.vmax] as [number, number, number, number | null]),
    }));
}

/**
 * The GFS cycles to look for on NOMADS: the newest one about 5 h old (when the
 * tracker file is out), then the one before it.
 */
export function latestGfsCycles(nowMs: number): { date: string; cycle: string }[] {
    const latest = Math.floor((nowMs - 5 * 3_600_000) / 21_600_000) * 21_600_000;
    return [latest, latest - 21_600_000].map((t) => {
        const d = new Date(t).toISOString();
        return { date: d.slice(0, 10).replace(/-/g, ''), cycle: d.slice(11, 13) };
    });
}
