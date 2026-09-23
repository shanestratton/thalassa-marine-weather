import { useEffect, useRef, useState } from 'react';
import { NmeaStore, getNmeaFreshness, type NmeaStoreState } from '../services/NmeaStore';
import { NmeaListenerService } from '../services/NmeaListenerService';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../services/authIdentityScope';
import {
    calculatePassageEta,
    PASSAGE_ETA_POLL_MS,
    PASSAGE_ETA_REFRESH_MS,
    PassagePositionSpeed,
    PassageSpeedHistory,
    stabilizePassageEta,
    type PassageEta,
    type PassageEtaInput,
    type PassageSpeedObservation,
} from '../services/passageEta';

/** Only source-timed local boat SOG may train the estimate; never phone/cloud speed. */
export function passageEtaBoatObservation(
    state: Pick<NmeaStoreState, 'connectionStatus' | 'remote' | 'sog' | 'gpsSource'>,
    isBoatFeed: boolean,
    source: string,
    now: number,
): PassageSpeedObservation | null {
    if (
        !isBoatFeed ||
        state.connectionStatus !== 'connected' ||
        state.remote !== null ||
        state.sog.freshness !== 'live' ||
        getNmeaFreshness(state.sog.lastUpdated, now) !== 'live' ||
        state.sog.value === null ||
        !Number.isFinite(state.sog.value) ||
        state.sog.value < 0 ||
        state.sog.value > 100
    )
        return null;
    // LAN receipt-stamped SOG is deliberately excluded here. Its genuine
    // position clock is handled separately below; fresh ZDA is never a speed.
    return { at: state.sog.lastUpdated, speedKts: state.sog.value, source };
}

export function passageEtaLanPosition(
    state: Pick<NmeaStoreState, 'connectionStatus' | 'remote' | 'latitude' | 'longitude'>,
    isBoatFeed: boolean,
    source: string,
    now: number,
) {
    const remote = state.remote;
    const at = remote?.positionSampleAt;
    if (
        !isBoatFeed ||
        state.connectionStatus !== 'remote' ||
        remote?.via !== 'lan' ||
        remote.source !== 'pi' ||
        at === undefined ||
        getNmeaFreshness(at, now) !== 'live' ||
        state.latitude.freshness !== 'live' ||
        state.longitude.freshness !== 'live' ||
        state.latitude.lastUpdated !== remote.receivedAt ||
        state.longitude.lastUpdated !== remote.receivedAt ||
        state.latitude.value === null ||
        state.longitude.value === null ||
        !Number.isFinite(state.latitude.value) ||
        !Number.isFinite(state.longitude.value) ||
        Math.abs(state.latitude.value) > 90 ||
        Math.abs(state.longitude.value) > 180 ||
        (state.latitude.value === 0 && state.longitude.value === 0)
    )
        return null;
    return { at, lat: state.latitude.value, lon: state.longitude.value, source };
}

const hasRemainingDistance = (input: PassageEtaInput): boolean =>
    input.remainingNm !== null && Number.isFinite(input.remainingNm) && input.remainingNm >= 0;

/** Samples at 15 s, publishes at most once a minute except loss/stop/basis changes. */
export function usePassageEta(input: PassageEtaInput): PassageEta {
    const inputs = useRef(input);
    inputs.current = input;
    const history = useRef(new PassageSpeedHistory());
    const positions = useRef(new PassagePositionSpeed());
    const [eta, setEta] = useState<PassageEta>(() => calculatePassageEta(input, null, Date.now()));
    const etaRef = useRef(eta);
    const lastPublished = useRef(0);

    const publish = useRef((force: boolean) => {
        const now = Date.now();
        const next = calculatePassageEta(inputs.current, history.current.summary(now), now);
        const changedBasis = next.basis !== etaRef.current.basis;
        const elapsed = now - lastPublished.current;
        // A device clock correction must not freeze the rolling ETA until the
        // old wall-clock time catches up. Only throttle forward-moving time.
        if (!force && !changedBasis && elapsed >= 0 && elapsed < PASSAGE_ETA_REFRESH_MS) return;
        const stable = force ? next : stabilizePassageEta(etaRef.current, next);
        lastPublished.current = now;
        etaRef.current = stable;
        setEta((previous) => (previous === stable ? previous : stable));
    });

    useEffect(() => {
        const speedHistory = history.current;
        const positionHistory = positions.current;
        speedHistory.clear();
        positionHistory.clear();
        let observedSource: string | null = null;
        const read = (state: NmeaStoreState, now: number) => {
            const identity = getAuthIdentityScope();
            const endpoint = NmeaListenerService.getConnectionInfo();
            const boatFeed = NmeaStore.isBoatFeed();
            const lane = state.remote
                ? `pi-lan:${state.remote.deviceLabel ?? ''}:position`
                : `gateway:${endpoint.host}:${endpoint.port}:${endpoint.deviceId ?? ''}:sog`;
            const source = `${identity.key}:${identity.generation}:${lane}:${state.gpsSource ?? ''}`;
            const usableRoute = inputs.current.routeKey && hasRemainingDistance(inputs.current);
            const lan = usableRoute ? passageEtaLanPosition(state, boatFeed, source, now) : null;
            const direct = usableRoute ? passageEtaBoatObservation(state, boatFeed, source, now) : null;
            return { lan, direct, source: lan || direct ? source : null };
        };
        const sample = () => {
            const now = Date.now();
            const { lan, direct, source } = read(NmeaStore.getState(), now);
            observedSource = source;
            const derived = positionHistory.observe(lan, now);
            speedHistory.observe(direct ?? derived, now);
            publish.current(false);
        };
        sample();
        publish.current(true);
        const timer = setInterval(sample, PASSAGE_ETA_POLL_MS);
        // Watchdog/source-loss notifications may retire an estimate right
        // away. Ordinary new fixes never add samples or repaint from here.
        const unsubscribeHealth = NmeaStore.subscribe((state) => {
            const { source } = read(state, Date.now());
            if (observedSource === null || source === observedSource) return;
            observedSource = source;
            speedHistory.clear();
            positionHistory.clear();
            publish.current(true);
        });
        const unsubscribe = subscribeAuthIdentityScope(() => {
            observedSource = null;
            speedHistory.clear();
            positionHistory.clear();
            publish.current(true);
        });
        return () => {
            clearInterval(timer);
            unsubscribe();
            unsubscribeHealth();
            speedHistory.clear();
            positionHistory.clear();
        };
    }, [input.routeKey]);

    // A selected departure/configuration is intentional, unlike each GPS
    // movement of remainingNm; apply it immediately without resetting history.
    useEffect(() => {
        publish.current(true);
    }, [input.cruiseKts, input.departureMs, input.forecastOn]);

    const distanceAvailable = hasRemainingDistance(input);
    useEffect(() => {
        if (!distanceAvailable) {
            history.current.clear();
            positions.current.clear();
        }
        publish.current(true);
    }, [distanceAvailable]);

    return eta;
}
