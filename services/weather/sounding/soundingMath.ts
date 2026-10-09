/**
 * soundingMath — the physics behind the Sounding sheet (build 125, SND).
 *
 * Ported from the approved mock-up (scratch make.py, Shane 2026-10-09): Magnus
 * dewpoint, Bolton's LCL, a pseudo-adiabatic parcel, the freezing level by
 * interpolation, inversions and the dry "trade lid". Pure functions on one
 * profile: the surface first, then each pressure level above it.
 *
 * Two deliberate departures from the mock-up, both where the plan asks for
 * something the script did not do:
 *  - the INVERSION is the strongest one below 700 hPa (the script kept the
 *    last one it met);
 *  - the FREEZING LEVEL is the lowest 0 °C crossing, the standard definition
 *    (the script kept the highest, which only differs with a warm nose).
 */
import type { SpeedUnit } from '../../../types/units';

export interface SoundingLevel {
    /** Pressure, hPa. */
    p: number;
    /** Temperature, °C. */
    t: number;
    /** Dewpoint, °C. */
    td: number;
    /** Geopotential height above sea level, m (null when the model gave none). */
    z: number | null;
    windKmh: number | null;
    /** Direction the wind blows FROM, degrees true. */
    windFrom: number | null;
}

/** Dewpoint from temperature and relative humidity (Magnus, Alduchov–Eskridge). */
export function magnusDewpoint(tC: number, rhPct: number): number {
    const b = 17.625;
    const c = 243.04;
    const gm = Math.log(Math.max(rhPct, 1) / 100) + (b * tC) / (c + tC);
    return (c * gm) / (b - gm);
}

/** Bolton (1980) eq. 15: the lifting condensation level's temperature (K) and pressure. */
export function lclBolton(tC: number, tdC: number, pHpa: number): { tK: number; pHpa: number } {
    const tK = tC + 273.15;
    const tdK = tdC + 273.15;
    const tl = 1 / (1 / (tdK - 56) + Math.log(tK / tdK) / 800) + 56;
    return { tK: tl, pHpa: pHpa * (tl / tK) ** (1 / 0.2857) };
}

/** Cloud base above the surface by the 125 m per °C spread rule, unrounded. */
export function cloudBaseRawMetres(tC: number, tdC: number): number {
    return Math.max(0, tC - tdC) * 125;
}

/** Cloud base to the nearest 50 m: seven levels allow no finer. */
export function cloudBaseMetres(tC: number, tdC: number): number {
    return Math.round(cloudBaseRawMetres(tC, tdC) / 50) * 50;
}

const saturationVapourHpa = (tC: number) => 6.112 * Math.exp((17.67 * tC) / (tC + 243.5));

/** dT/dp along a pseudo-adiabat, K per hPa. */
function moistLapse(tC: number, pHpa: number): number {
    const tK = tC + 273.15;
    const e = saturationVapourHpa(tC);
    const w = (0.622 * e) / (pHpa - e);
    const lv = 2.501e6;
    const rd = 287.04;
    const num = (rd * tK + lv * w) / pHpa;
    const den = 1005.7 + (lv * lv * w * 0.622) / (rd * tK * tK);
    return num / den;
}

/** One step up a pseudo-adiabat from (tC, pHpa) to pTo, in 1 hPa steps. */
export function moistAscent(tC: number, pHpa: number, pTo: number): number {
    let t = tC;
    let p = pHpa;
    while (p > pTo) {
        const dp = Math.max(-1, pTo - p);
        t += moistLapse(t, p) * dp;
        p += dp;
    }
    return t;
}

export interface SurfaceAir {
    p: number;
    t: number;
    td: number;
}

/** A surface parcel's temperature at pHpa: the dry adiabat to the LCL, then the pseudo-adiabat. */
export function parcelTemperature(pHpa: number, surface: SurfaceAir): number {
    const lcl = lclBolton(surface.t, surface.td, surface.p);
    if (pHpa >= lcl.pHpa) return (surface.t + 273.15) * (pHpa / surface.p) ** 0.2857 - 273.15;
    return moistAscent(lcl.tK - 273.15, lcl.pHpa, pHpa);
}

/** The parcel's path from the surface to topHpa every stepHpa, integrated once. */
export function parcelPath(surface: SurfaceAir, topHpa = 250, stepHpa = 5): { p: number; t: number }[] {
    const lcl = lclBolton(surface.t, surface.td, surface.p);
    const out: { p: number; t: number }[] = [];
    let moist: { p: number; t: number } | null = null;
    for (let p = surface.p; p >= topHpa; p -= stepHpa) {
        if (p >= lcl.pHpa) {
            out.push({ p, t: (surface.t + 273.15) * (p / surface.p) ** 0.2857 - 273.15 });
            continue;
        }
        moist ??= { p: lcl.pHpa, t: lcl.tK - 273.15 };
        moist = { p, t: moistAscent(moist.t, moist.p, p) };
        out.push(moist);
    }
    return out;
}

/** Surface pressure from the sea-level value by the hypsometric equation. */
export function surfacePressureHpa(mslpHpa: number, elevationM: number, t2mC: number): number {
    if (!elevationM) return mslpHpa;
    const meanK = t2mC + 273.15 + (0.0065 * elevationM) / 2;
    return mslpHpa * Math.exp((-9.80665 * elevationM) / (287.05 * meanK));
}

/**
 * Heights the model left out, filled from the level below by the hypsometric
 * equation over the layer's mean virtual temperature. A partial sync can drop
 * a geopotential height and keep the temperatures; the surface's height (the
 * grid point's elevation) is always known, so every level above gets one.
 */
export function fillMissingHeights(profile: SoundingLevel[]): SoundingLevel[] {
    const virtualK = (q: SoundingLevel) => {
        const e = saturationVapourHpa(q.td);
        return (q.t + 273.15) * (1 + (0.61 * 0.622 * e) / (q.p - e));
    };
    const out: SoundingLevel[] = [];
    for (const level of profile) {
        const below = out[out.length - 1];
        if (level.z != null || !below || below.z == null) {
            out.push(level);
            continue;
        }
        const meanK = (virtualK(level) + virtualK(below)) / 2;
        out.push({ ...level, z: below.z + ((287.05 * meanK) / 9.80665) * Math.log(below.p / level.p) });
    }
    return out;
}

/** Temperature at pHpa, linear in log-p between the profile's points. */
export function temperatureAt(profile: SoundingLevel[], pHpa: number): number | null {
    for (let i = 0; i < profile.length - 1; i++) {
        const a = profile[i];
        const b = profile[i + 1];
        if (a.p >= pHpa && pHpa >= b.p) {
            const f = (Math.log(a.p) - Math.log(pHpa)) / (Math.log(a.p) - Math.log(b.p));
            return a.t + f * (b.t - a.t);
        }
    }
    return null;
}

/**
 * Height of the lowest 0 °C crossing, m above sea level; the surface height
 * when it is already freezing there; null when the column never reaches 0 °C
 * (or a height beside the crossing is missing: fillMissingHeights first).
 */
export function freezingLevelMetres(profile: SoundingLevel[]): number | null {
    if (!profile.length) return null;
    if (profile[0].t <= 0) return profile[0].z ?? 0;
    for (let i = 0; i < profile.length - 1; i++) {
        const a = profile[i];
        const b = profile[i + 1];
        if (a.t > 0 && b.t <= 0 && a.z != null && b.z != null) {
            return a.z + (a.t / (a.t - b.t)) * (b.z - a.z);
        }
    }
    return null;
}

/**
 * The warmest layer above 0 °C below 700 hPa when the surface is at or below
 * 0 °C: a warm nose, where snow melts on the way down and the rain refreezes
 * on whatever it lands on. Null when the surface is above freezing.
 */
export function warmNose(profile: SoundingLevel[]): { p: number; t: number } | null {
    if (!profile.length || profile[0].t > 0) return null;
    let best: { p: number; t: number } | null = null;
    for (const q of profile.slice(1)) {
        if (q.p < 700) break;
        if (q.t > 0 && (!best || q.t > best.t)) best = { p: q.p, t: q.t };
    }
    return best;
}

export interface Inversion {
    baseHpa: number;
    topHpa: number;
    warmingC: number;
}

/** The strongest layer below 700 hPa that warms with height by more than 0.2 °C. */
export function strongestInversion(profile: SoundingLevel[]): Inversion | null {
    let best: Inversion | null = null;
    for (let i = 0; i < profile.length - 1; i++) {
        const a = profile[i];
        const b = profile[i + 1];
        if (b.p < 700) break;
        const warming = b.t - a.t;
        if (warming > 0.2 && (!best || warming > best.warmingC)) {
            best = { baseHpa: a.p, topHpa: b.p, warmingC: Math.round(warming * 100) / 100 };
        }
    }
    return best;
}

export interface DryLid {
    baseHpa: number;
    topHpa: number;
    baseM: number;
    topM: number;
    lapseCPerKm: number;
    dewpointDropC: number;
}

/**
 * The first layer below 700 hPa that cools slowly (under 3.5 °C/km) while the
 * dewpoint falls away (by more than 5 °C): dry, stable air capping the cloud.
 * Layers that warm with height are inversions, never lids.
 */
export function dryLid(profile: SoundingLevel[]): DryLid | null {
    for (let i = 0; i < profile.length - 1; i++) {
        const a = profile[i];
        const b = profile[i + 1];
        if (b.p < 700) break;
        if (b.t > a.t + 0.2 || a.z == null || b.z == null) continue;
        const dzKm = (b.z - a.z) / 1000;
        if (dzKm <= 0.2) continue;
        const lapse = (a.t - b.t) / dzKm;
        const drop = a.td - b.td;
        if (lapse < 3.5 && drop > 5) {
            return { baseHpa: a.p, topHpa: b.p, baseM: a.z, topM: b.z, lapseCPerKm: lapse, dewpointDropC: drop };
        }
    }
    return null;
}

const KNOTS_PER: Record<SpeedUnit, number> = { kts: 1, kmh: 1 / 1.852, mps: 3.6 / 1.852, mph: 1.609344 / 1.852 };

export function toKnots(speed: number, unit: SpeedUnit): number {
    return speed * KNOTS_PER[unit];
}

/** km/h into the skipper's speed unit. */
export function fromKmh(kmh: number, unit: SpeedUnit): number {
    return toKnots(kmh, 'kmh') / KNOTS_PER[unit];
}

export interface BarbParts {
    /** The speed the barb draws, knots to the nearest 5. */
    knots: number;
    pennants: number;
    full: number;
    half: number;
    calm: boolean;
}

/**
 * A wind barb's flags. Barbs are drawn in knots whatever the skipper reads
 * (the WMO convention: 50 kt a pennant, 10 a full barb, 5 a half), so every
 * unit converts first; the figures beside them use the skipper's own unit.
 */
export function barbParts(speed: number, unit: SpeedUnit): BarbParts {
    const kt = toKnots(speed, unit);
    if (kt < 2.5) return { knots: 0, pennants: 0, full: 0, half: 0, calm: true };
    const knots = Math.round(kt / 5) * 5;
    let rest = knots;
    const pennants = Math.floor(rest / 50);
    rest -= pennants * 50;
    const full = Math.floor(rest / 10);
    rest -= full * 10;
    return { knots, pennants, full, half: rest >= 5 ? 1 : 0, calm: false };
}
