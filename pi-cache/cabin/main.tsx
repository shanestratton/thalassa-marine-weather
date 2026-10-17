import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HeadingGauge } from '../../components/nmea/gauges/HeadingGauge';
import { BarometerGauge } from '../../components/nmea/gauges/BarometerGauge';
import { CABIN_STALE_MS, cabinRecent, parseCabinSnapshot, type CabinSnapshot } from '../src/cabin/wire';
import './style.css';
import { readCabinJson } from './browserRead';

const VIEWER_HEADER = 'x-thalassa-cabin-viewer';
export function CabinDisplay() {
    const [token, setToken] = useState<string | null>(null),
        [code, setCode] = useState('');
    const [message, setMessage] = useState('Enter the cabin code shown on the boat’s Pi.');
    const [snapshot, setSnapshot] = useState<CabinSnapshot | null>(null),
        [elapsed, setElapsed] = useState(0);
    const [night, setNight] = useState(true),
        [busy, setBusy] = useState(false);
    const generation = useRef(0),
        received = useRef(0),
        pairing = useRef<AbortController | null>(null);
    useEffect(
        () => () => {
            generation.current += 1;
            pairing.current?.abort();
        },
        [],
    );
    useEffect(() => {
        if (!token) return;
        const owner = ++generation.current;
        let timer: ReturnType<typeof setTimeout> | undefined,
            pending: AbortController | null = null,
            request = 0;
        const current = () => generation.current === owner;
        const poll = async () => {
            if (!current() || document.hidden) return;
            const controller = new AbortController(),
                run = ++request;
            const live = () => current() && run === request;
            let timedOut = false;
            pending = controller;
            const deadline = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, 5_000);
            try {
                const response = await fetch('/api/telemetry', {
                    headers: { [VIEWER_HEADER]: token },
                    cache: 'no-store',
                    credentials: 'omit',
                    redirect: 'error',
                    signal: controller.signal,
                });
                if (!live() || controller.signal.aborted) return;
                if (response.status === 401) {
                    setToken(null);
                    setSnapshot(null);
                    setMessage('Pair this display again with a current cabin code.');
                    return;
                }
                if (!response.ok) throw Error('Unavailable');
                const data = parseCabinSnapshot(await readCabinJson(response, 16_384, controller.signal));
                if (!data) throw Error('Unavailable');
                if (!live() || controller.signal.aborted) return;
                received.current = performance.now();
                setElapsed(0);
                setSnapshot(data);
                setMessage('');
            } catch {
                if (live() && (!controller.signal.aborted || timedOut)) {
                    setSnapshot(null);
                    setMessage('Pi connection unavailable. Instrument and alarm status is unknown.');
                }
            } finally {
                clearTimeout(deadline);
                if (pending === controller) pending = null;
                if (live() && !document.hidden) timer = setTimeout(() => void poll(), 2_000);
            }
        };
        const visibility = () => {
            request++;
            if (timer) clearTimeout(timer);
            pending?.abort();
            pending = null;
            setSnapshot(null);
            if (!document.hidden) void poll();
        };
        document.addEventListener('visibilitychange', visibility);
        void poll();
        const age = setInterval(() => {
            if (current()) setElapsed(performance.now() - received.current);
        }, 1_000);
        return () => {
            generation.current += 1;
            clearInterval(age);
            if (timer) clearTimeout(timer);
            pending?.abort();
            document.removeEventListener('visibilitychange', visibility);
        };
    }, [token]);
    const pair = async (event: React.FormEvent) => {
        event.preventDefault();
        if (busy) return;
        const owner = ++generation.current,
            controller = new AbortController();
        pairing.current?.abort();
        pairing.current = controller;
        setBusy(true);
        const deadline = setTimeout(() => controller.abort(), 5_000);
        try {
            const response = await fetch('/api/cabin/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'error',
                signal: controller.signal,
            });
            const value = await readCabinJson(response, 512, controller.signal),
                session = value as { token?: unknown; expiresAt?: unknown };
            if (generation.current !== owner || controller.signal.aborted) return;
            if (!response.ok || typeof session.token !== 'string' || !/^cabin-[a-f0-9]{64}$/.test(session.token))
                throw Error('Not accepted');
            setCode('');
            setToken(session.token);
            setMessage('Connecting to the Pi…');
        } catch {
            if (generation.current === owner) setMessage('The code is unavailable, expired or not accepted.');
        } finally {
            clearTimeout(deadline);
            if (generation.current === owner) setBusy(false);
        }
    };
    const clock = snapshot ? snapshot.servedAt + elapsed : 0;
    const recent =
        !!snapshot && elapsed < CABIN_STALE_MS && cabinRecent(snapshot.reportedAt, clock) && snapshot.available;
    const readings = recent
        ? snapshot.readings
        : { heading: null, pressure: null, speed: null, wind: null, depth: null };
    const watch = snapshot?.watch,
        watchRecent = !!watch && elapsed < CABIN_STALE_MS && cabinRecent(watch.lastPassAt, clock);
    return (
        <main className={night ? 'cabin night' : 'cabin'}>
            <header>
                <div>
                    <strong>THALASSA</strong>
                    <span>Cabin display · read only</span>
                </div>
                <button type="button" onClick={() => setNight(!night)}>
                    {night ? 'Day colours' : 'Night colours'}
                </button>
            </header>
            {!token ? (
                <form onSubmit={(event) => void pair(event)}>
                    <h1>Pair this display</h1>
                    <label htmlFor="cabin-code">Cabin code</label>
                    <input
                        id="cabin-code"
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        pattern="[0-9]{8}"
                        minLength={8}
                        maxLength={8}
                        required
                        value={code}
                        onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
                    />
                    <button disabled={busy}>{busy ? 'Connecting…' : 'Show instruments'}</button>
                    <p role="status">{message}</p>
                </form>
            ) : (
                <>
                    <p role="status" className="status">
                        {message ||
                            (recent
                                ? `Pi snapshot · ${Math.max(0, Math.floor((clock - snapshot.reportedAt!) / 1000))} seconds old`
                                : 'Instrument data unavailable or old')}
                    </p>
                    <section className="dials" aria-label="Instrument display">
                        <HeadingGauge value={readings.heading} isLive={recent} label="Heading from Pi" />
                        <BarometerGauge hpa={readings.pressure} />
                    </section>
                    <section className="numbers" aria-label="Instrument readings">
                        {(
                            [
                                ['Speed', readings.speed, 'kn'],
                                ['True wind', readings.wind, 'kn'],
                                ['Depth', readings.depth, 'm'],
                            ] as const
                        ).map(([label, value, unit]) => (
                            <div key={label}>
                                <span>{label}</span>
                                <strong>
                                    {value === null ? '—' : value.toFixed(1)} <small>{unit}</small>
                                </strong>
                            </div>
                        ))}
                    </section>
                    <section className="alarm-mirror" aria-label="Pi alarm mirror">
                        <h2>Pi alarm mirror</h2>
                        <p>
                            {!snapshot?.anchor || elapsed >= CABIN_STALE_MS
                                ? 'Anchor watch status unavailable'
                                : !snapshot.anchor.running
                                  ? 'Anchor watch is off'
                                  : snapshot.anchor.dragging
                                    ? 'Anchor drag reported · sample time unavailable'
                                    : 'Anchor watch active · latest drag status unavailable'}
                        </p>
                        <p>
                            {!watch
                                ? 'Watch status unavailable'
                                : watch.state === 'off'
                                  ? 'Collision watch is off'
                                  : !watchRecent
                                    ? 'Watch status is old or unavailable'
                                    : `Collision watch: ${watch.state === 'armed' ? 'watching' : watch.state}`}
                        </p>
                        {!!watch?.alarms.length && (
                            <ul>
                                {watch.alarms.map((alarm) => (
                                    <li
                                        className={alarm.acknowledgedAt === null ? 'sounding' : ''}
                                        key={`${alarm.kind}:${alarm.mmsi}:${alarm.raisedAt}`}
                                    >
                                        <strong>
                                            {alarm.kind === 'close-quarters'
                                                ? 'Close quarters'
                                                : alarm.kind === 'distress'
                                                  ? 'Distress'
                                                  : 'Collision'}
                                        </strong>{' '}
                                        · {alarm.name || alarm.mmsi}
                                        {alarm.lost ? ' · contact lost' : ''}
                                        {alarm.acknowledgedAt !== null ? ' · acknowledged aboard' : ''}
                                        {!watchRecent ? ' · last reported' : ''}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {watchRecent && watch?.state !== 'off' && !watch?.alarms.length && (
                            <p>No alarms reported by the Pi.</p>
                        )}
                        <p className="small">
                            Collision phone alerts:{' '}
                            {!watchRecent
                                ? 'status unavailable'
                                : watch?.push === 'ready'
                                  ? 'available'
                                  : watch?.push === 'internet-off'
                                    ? 'internet off'
                                    : watch?.push === 'not-paired'
                                      ? 'not paired'
                                      : 'unavailable'}
                        </p>
                        <p className="small">
                            Alarm status comes from the Pi’s existing watch. This display has no arm, silence or
                            stand-down controls.
                        </p>
                    </section>
                </>
            )}
        </main>
    );
}

const target = document.getElementById('root');
if (target) createRoot(target).render(<CabinDisplay />);
