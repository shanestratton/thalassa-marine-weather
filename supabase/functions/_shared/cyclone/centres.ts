/**
 * Who issues the official tropical cyclone warning for a position: the WMO
 * Regional Specialised Meteorological Centre (RSMC) or Tropical Cyclone
 * Warning Centre (TCWC) for that ocean (129-09). Pure and dependency-free:
 * the app's storm layer and the cyclone-watch push both read it.
 *
 * Drawn: NHC and CPHC, read direct from NOAA (129-09b: NOAA's own
 * NHC_tropical_weather MapServer and NHC's CurrentStorms.json; US Government
 * work, public domain per weather.gov/disclaimer, read 2026-10-14, and still
 * credited "NHC (NOAA)"). Every other centre is a link until its terms are
 * checked. JTWC is never the official warning: it is a US military advisory,
 * read from JTWC's own products, and is labelled as one.
 *
 * Areas, checked 2026-10-14:
 *   RSMC Miami (NHC): North Atlantic, and the East Pacific east of 140°W.
 *   RSMC Honolulu (CPHC): North Pacific, 140°W to 180°.
 *   RSMC Tokyo (JMA): North West Pacific, 100°E to 180°.
 *   RSMC New Delhi (IMD): the North Indian Ocean, Bay of Bengal and Arabian
 *     Sea (south of 30°N, east of 40°E: not the Mediterranean, the Black Sea
 *     or the Caspian).
 *   RSMC La Réunion: South Indian Ocean, Africa to 90°E.
 *   Australian region, 90°E to 160°E: the Bureau of Meteorology (one TCWC
 *     since 2020-21), with TCWC Jakarta (BMKG's polygon: 0-10°S 90-120°E,
 *     0-11°S 120-128°E, 0-9°S 128-141°E) and TCWC Port Moresby (north of
 *     about 10°S, 141°E to 160°E; its southern edge is irregular).
 *   South Pacific, 160°E to 120°W: RSMC Nadi north of 25°S, TCWC Wellington
 *     south of it.
 *   South Atlantic: no RSMC; the Brazilian Navy names and warns in METAREA V,
 *     west of 20°W and north of about 35.8°S (Argentina's METAREA VI south).
 *   An East Pacific storm keeps its EP id west of 140°W, where CPHC writes its
 *   advisories: the issuer is decided by position, not the id.
 *   Anywhere else (the Mediterranean, the South East Pacific): the WMO's own
 *     Severe Weather Information Centre, never a guessed neighbour.
 */

export type CycloneCentreId =
    | 'nhc'
    | 'cphc'
    | 'jma'
    | 'imd'
    | 'reunion'
    | 'bom'
    | 'jakarta'
    | 'portmoresby'
    | 'nadi'
    | 'wellington'
    | 'brazil'
    | 'wmo';

export interface CycloneCentre {
    id: CycloneCentreId;
    /** The centre's name on the chart, the card and the push. */
    short: string;
    /** The centre's own public page (opened 2026-10-14; the BoM page is the 2026-10-07 one). */
    url: string;
    /** Thalassa draws this centre's own track and cone (public domain). */
    drawn: boolean;
}

const c = (id: CycloneCentreId, short: string, url: string, drawn = false): CycloneCentre => ({
    id,
    short,
    url,
    drawn,
});

export const CYCLONE_CENTRES: Record<CycloneCentreId, CycloneCentre> = {
    // US National Hurricane Center (RSMC Miami)
    nhc: c('nhc', 'NHC', 'https://www.nhc.noaa.gov/', true),
    // Central Pacific Hurricane Center (RSMC Honolulu)
    cphc: c('cphc', 'CPHC', 'https://www.nhc.noaa.gov/?cpac', true),
    // Japan Meteorological Agency
    jma: c('jma', 'RSMC Tokyo', 'https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/RSMC_HP.htm'),
    // India Meteorological Department
    imd: c('imd', 'RSMC New Delhi', 'https://rsmcnewdelhi.imd.gov.in/'),
    // Météo-France La Réunion
    reunion: c('reunion', 'RSMC La Réunion', 'https://meteofrance.re/fr/cyclone'),
    // The Bureau's single TCWC
    bom: c('bom', 'Bureau of Meteorology', 'https://www.bom.gov.au/weather-and-climate/warnings-and-alerts'),
    // BMKG Indonesia
    jakarta: c('jakarta', 'TCWC Jakarta', 'https://www.bmkg.go.id/cuaca/siklon-tropis'),
    // PNG National Weather Service
    portmoresby: c('portmoresby', 'TCWC Port Moresby', 'https://www.pngmet.gov.pg/'),
    // Fiji Meteorological Service
    nadi: c('nadi', 'RSMC Nadi', 'https://www.met.gov.fj/tropical-cyclone/'),
    // MetService New Zealand
    wellington: c('wellington', 'TCWC Wellington', 'https://www.metservice.com/warnings/marine'),
    // Brazilian Navy Hydrographic Centre, METAREA V
    brazil: c(
        'brazil',
        'Brazilian Navy',
        'https://www.marinha.mil.br/chm/dados-do-smm-avisos-de-mau-tempo/avisos-de-mau-tempo',
    ),
    wmo: c('wmo', 'WMO Severe Weather Information Centre', 'https://severeweather.wmo.int/'),
};

/** The centre responsible for warnings at a position, anywhere. */
export function cycloneCentre(lat: number, lon: number): CycloneCentre {
    const C = CYCLONE_CENTRES;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return C.wmo;
    const x = ((((lon + 180) % 360) + 360) % 360) - 180;
    if (lat >= 0) {
        if (x >= -140 && x < 0) return C.nhc;
        if (x < -140) return C.cphc;
        if (x >= 100) return C.jma;
        return x >= 40 && lat < 30 ? C.imd : C.wmo;
    }
    if (x >= 20 && x < 90) return C.reunion;
    if (x >= 90 && x < 160) {
        if (x < 141 && lat > (x < 120 ? -10 : x < 128 ? -11 : -9)) return C.jakarta;
        if (x >= 141 && lat > -10) return C.portmoresby;
        return C.bom;
    }
    if (x >= 160 || x < -120) return lat >= -25 ? C.nadi : C.wellington;
    return x >= -70 && x < -20 && lat > -35.8 ? C.brazil : C.wmo;
}

/** Who wrote a forecast track Thalassa holds. */
export type TrackIssuer = 'NHC' | 'CPHC' | 'JTWC';

/**
 * NHC or CPHC, from the product itself: the office in its AWIPS id ("MIA" for
 * NHC in Miami, "HFO" for CPHC in Honolulu, as in .../text/HFOTCMEP4.shtml).
 * An East Pacific storm keeps its EP id after it crosses into CPHC's waters,
 * so the basin letters alone cannot say. With no office in the product, the
 * storm's position decides, as cycloneCentre does (west of 140°W north of the
 * equator is CPHC's).
 */
export function productIssuer(urls: unknown[], lat: number, lon: number): 'NHC' | 'CPHC' {
    for (const u of urls) {
        const office = /\/(MIA|HFO)TC[A-Z]{1,2}(?:AT|EP|CP)\d/i.exec(String(u ?? ''))?.[1]?.toUpperCase();
        if (office) return office === 'HFO' ? 'CPHC' : 'NHC';
    }
    return cycloneCentre(lat, lon).id === 'cphc' ? 'CPHC' : 'NHC';
}

export const JTWC_NOT_OFFICIAL = 'JTWC: US military advisory, not the official warning here';

/** How a track is named on the chart, in the card and in the push. */
export function trackIssuerLabel(issuer: TrackIssuer, centre: CycloneCentre): { official: boolean; text: string } {
    if (issuer === 'JTWC') return { official: false, text: JTWC_NOT_OFFICIAL };
    return centre.drawn
        ? { official: true, text: `${issuer} official forecast` }
        : { official: false, text: `${issuer} forecast, not the official warning here` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "14 Oct 03:10 UTC". Advisories are UTC everywhere in the storm view. */
export function utcLabel(ms: number): string {
    const d = new Date(ms);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * A forecast point's valid time: VALIDTIME ("DD/HHMM", UTC; NOAA's forecast
 * points, JTWC's DDHHMM stamps) in the month before, of or after a reference
 * time near it (the advisory, epoch ms), whichever puts it nearest: an
 * advisory issued just after 00Z on the 1st still has tau 0 on the last day of
 * the month before. A day that month does not have (31 November) is not rolled
 * into the next, and a time more than 3 days before or 8 days after the
 * reference is no forecast point of it: null. NOAA's FLDATELBL is local time
 * for NHC storms ("5:00 AM Tue MST"), so reading it as UTC put East Pacific
 * points seven hours early.
 */
export function validTimeNear(validTime: unknown, advDateMs: unknown): string | null {
    const m = /^(\d{1,2})\/(\d{2})(\d{2})$/.exec(String(validTime ?? '').trim());
    const adv = Number(advDateMs);
    if (!m || !Number.isFinite(adv) || advDateMs == null || +m[2] > 23 || +m[3] > 59) return null;
    const a = new Date(adv);
    let best: number | null = null;
    for (const dm of [-1, 0, 1]) {
        const t = Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + dm, +m[1], +m[2], +m[3]);
        if (new Date(t).getUTCDate() !== +m[1]) continue;
        if (t < adv - 3 * 86_400_000 || t > adv + 8 * 86_400_000) continue;
        if (best === null || Math.abs(t - adv) < Math.abs(best - adv)) best = t;
    }
    return best === null ? null : new Date(best).toISOString();
}
