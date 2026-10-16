import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import {
    FORECAST_TTL_MS,
    loadRouteForecast,
    peekRouteForecast,
    routeForecastKey,
    sampleCoveredRouteWind,
    type RouteForecast,
} from '../../services/routeForecastSampler';
import { recommendSailPlan, type SailRecommendation } from '../../services/sailing/sailInventory';
import type { VesselProfile } from '../../types/vessel';

const subscribe = (notify: () => void) => subscribeAuthIdentityScope(() => notify());
export interface SailPassageLeg {
    name: string;
    timeMs: number;
    alongNm: number;
    courseDeg: number;
}

/** The expanded leg list reuses a fresh covered forecast, or asks explicitly for one bounded route batch. */
export default function PassageSailPlans(props: {
    vessel?: Partial<VesselProfile>;
    vesselKey: string;
    coords: ReadonlyArray<{ lat: number; lon: number }>;
    legs: SailPassageLeg[];
    model: string | null;
    provider: string;
    satelliteMode?: boolean;
    nowMs: number;
}) {
    const owner = useSyncExternalStore(subscribe, getAuthIdentityScope, getAuthIdentityScope);
    const scopeKey = `${owner.key}:${owner.generation}:${props.vesselKey}`;
    const key = JSON.stringify([scopeKey, props.coords, props.legs, props.model]);
    const currentKey = useRef(key);
    currentKey.current = key;
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const [loaded, setLoaded] = useState<{ key: string; value: RouteForecast | null } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const cached = props.model ? peekRouteForecast(props.coords, props.model, props.nowMs) : null;
    const candidate = loaded?.key === key ? loaded.value : cached;
    const nowMs = Math.max(props.nowMs, Date.now());
    const forecast =
        candidate &&
        candidate.model === props.model &&
        candidate.fetchedAt <= nowMs &&
        nowMs - candidate.fetchedAt <= FORECAST_TTL_MS
            ? candidate
            : null;
    let previous: SailRecommendation | null = null;
    const advice = props.legs.map((leg) => {
        const wind = sampleCoveredRouteWind(forecast, leg.alongNm, leg.timeMs);
        const sample =
            wind && wind.twsKts !== null && wind.twdDeg !== null
                ? {
                      twsKn: wind.twsKts,
                      gustKn: wind.gustKts,
                      twaDeg: Math.abs(((wind.twdDeg - leg.courseDeg + 540) % 360) - 180),
                      timeMs: leg.timeMs,
                      sourceKey: `${forecast!.model}:${forecast!.fetchedAt}:${routeForecastKey(props.coords, forecast!.model)}`,
                  }
                : null;
        const value = recommendSailPlan({
            inventory: props.vessel?.sailInventory,
            vesselType: props.vessel?.type,
            scopeKey,
            sample,
            previous,
        });
        previous = value;
        return value;
    });
    const load = async () => {
        if (!props.model || props.satelliteMode || busy === key || !props.legs.length || props.legs.length > 256)
            return;
        setBusy(key);
        const value = await loadRouteForecast(props.coords, props.model);
        if (mounted.current && currentKey.current === key && isAuthIdentityScopeCurrent(owner)) {
            setLoaded({ key, value });
            setBusy(null);
        }
    };
    return (
        <section className="space-y-2 rounded-lg border border-white/15 p-3" aria-label="Suggested sails by leg">
            <h3 className="text-sm font-bold text-amber-200">Suggested sails</h3>
            <p className="text-xs text-gray-400">
                At each leg's start and forecast time, from your crossover and reef points. Check changing conditions
                aboard.
            </p>
            {props.legs.map((leg, index) => (
                <p key={index} className="text-sm text-white" data-testid="leg-sail-plan">
                    <span className="font-bold">{leg.name}: </span>
                    {advice[index]?.text ?? 'Unavailable'}
                    {advice[index]?.held ? ' · holding reduced sail' : ''}
                </p>
            ))}
            <p className="text-xs text-gray-400">
                {forecast
                    ? `${props.provider} forecast via Open-Meteo, fetched ${new Date(forecast.fetchedAt).toLocaleString()}.`
                    : 'Needs your sail inventory, crossover and a covered named wind forecast.'}
            </p>
            <button
                type="button"
                className="min-h-11 rounded-lg border border-white/20 px-3 text-sm font-bold text-sky-200"
                disabled={!props.model || props.satelliteMode || busy === key}
                onClick={() => {
                    void load();
                }}
            >
                {busy === key
                    ? 'Loading wind…'
                    : props.satelliteMode
                      ? 'Satellite Mode: cached wind only'
                      : props.model
                        ? 'Load wind for sail plans'
                        : 'Choose a named wind model first'}
            </button>
        </section>
    );
}
