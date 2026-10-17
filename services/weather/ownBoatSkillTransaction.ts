/** Private Pi protocol only. No transport, provider, global auth or cloud imports. */
import {
    OWN_BOAT_SKILL as LIMIT,
    ownBoatExact,
    ownBoatBindingKey,
    ownBoatHex,
    ownBoatRecord,
    parseOwnBoatCapability,
    parseOwnBoatProposal,
    type OwnBoatCapability,
    type OwnBoatProposal,
} from '../../utils/ownBoatSkill';
import { decodeIssuedSkill, SKILL_LEADS, type IssuedSkill } from './modelSkill';
export interface PrivateBoatScore {
    logging: boolean;
    phase: string;
    lastMeasuredAt: number | null;
    generatedAt: number;
    scores: readonly IssuedSkill[];
}
export interface PrivateBoatSession {
    vesselName: string;
    saved: boolean;
    current(): boolean;
    prepare(): Promise<OwnBoatProposal>;
    confirm(logging: boolean): Promise<OwnBoatCapability>;
    read(): Promise<PrivateBoatScore>;
    off(clear: boolean): Promise<void>;
    release(): void;
    retire(): void;
}
export interface PrivateBoatPorts {
    ownerId: string;
    vesselId: string;
    vesselRevision: number;
    vesselName: string;
    piDeviceId: string;
    controllerId: string;
    current(): boolean;
    samePi(): boolean;
    request(path: string, body?: unknown, jwt?: string, cleanup?: boolean): Promise<unknown>;
    jwt(): Promise<string>;
    saved: OwnBoatCapability | null;
    save(value: OwnBoatCapability | null): void;
    now(): number;
    monotonic(): number;
    onRelease(): void;
}
export function createPrivateBoatSession(ports: PrivateBoatPorts): PrivateBoatSession {
    let closed = false,
        busy = false,
        epoch = 0;
    let capability = ports.saved,
        proposal: OwnBoatProposal | null = null;
    let read: { id: string; expires: number; at: number; mono: number } | null = null;
    const opened = ports.now(),
        mono = ports.monotonic();
    const current = () =>
        !closed &&
        ports.current() &&
        ports.now() >= opened - 1000 &&
        ports.monotonic() >= mono &&
        ports.monotonic() - mono < LIMIT.readMs;
    const guard = () => {
        if (!current()) throw Error('Private review expired or the account, vessel or Pi changed.');
    };
    const matches = (v: OwnBoatCapability['consent']['binding']) =>
        v.ownerId === ports.ownerId &&
        v.vesselId === ports.vesselId &&
        v.vesselRevision === ports.vesselRevision &&
        v.piDeviceId === ports.piDeviceId &&
        v.controllerId === ports.controllerId;
    // A vessel edit cannot strand the privacy stop. The original owner/Pi/
    // controller capability remains usable only for stop until re-reviewed.
    if (
        capability &&
        (capability.consent.binding.ownerId !== ports.ownerId ||
            capability.consent.binding.piDeviceId !== ports.piDeviceId ||
            capability.consent.binding.controllerId !== ports.controllerId)
    )
        capability = null;
    const stop = async (value: OwnBoatCapability, clear: boolean) => {
        if (!ports.samePi()) throw Error('Connect to the original paired Pi to confirm the local stop.');
        const result = await ports.request(
            clear ? 'clear' : 'off',
            { schema: 1, capability: value.capability },
            undefined,
            true,
        );
        if (
            !ownBoatRecord(result) ||
            !ownBoatExact(result, ['schema', 'state', 'cleared']) ||
            result.schema !== 1 ||
            result.state !== 'off' ||
            result.cleared !== clear
        )
            throw Error('The Pi’s local stop could not be confirmed.');
    };
    const release = () => {
        if (!closed) {
            closed = true;
            epoch++;
            read = null;
            proposal = null;
            ports.onRelease();
        }
    };
    const run = async <T>(work: (version: number) => Promise<T>): Promise<T> => {
        guard();
        if (busy) throw Error('A private scorecard request is already in progress.');
        busy = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    release();
                    reject(Error('Private Pi request timed out. Reopen to review again.'));
                }, LIMIT.operationMs);
            });
            return await Promise.race([work(epoch), timeout]);
        } finally {
            clearTimeout(timer);
            busy = false;
        }
    };
    return {
        vesselName: ports.vesselName,
        get saved() {
            return !!capability;
        },
        current,
        release,
        retire() {
            const old = capability;
            capability = null;
            try {
                ports.save(null);
            } catch {
                /* Account fence still retires in-memory access and attempts the local stop. */
            }
            release();
            if (old) void stop(old, false).catch(() => undefined);
        },
        prepare: () =>
            run(async (version) => {
                proposal = null;
                read = null;
                const jwt = await ports.jwt();
                guard();
                const value = parseOwnBoatProposal(
                    await ports.request('prepare', { schema: 1, vesselId: ports.vesselId }, jwt),
                    ports.now(),
                );
                guard();
                if (version !== epoch || !value || !matches(value.binding))
                    throw Error('The Pi could not verify this owned vessel and instrument association.');
                proposal = value;
                return value;
            }),
        confirm: (logging) =>
            run(async (version) => {
                const pending = proposal;
                proposal = null;
                if (!pending || ports.now() >= pending.expiresAt)
                    throw Error('The instrument review expired. Review again.');
                const jwt = await ports.jwt();
                guard();
                // Observe a late grant even after the awaiting UI retires: revoke it
                // on the original pinned Pi instead of persisting it to a successor.
                const operation = ports
                    .request('confirm', { schema: 1, nonce: pending.nonce, logging }, jwt)
                    .then(async (raw) => {
                        const value = parseOwnBoatCapability(raw, ports.now());
                        if (
                            !value ||
                            !matches(value.consent.binding) ||
                            ownBoatBindingKey(value.consent.binding) !== ownBoatBindingKey(pending.binding)
                        )
                            throw Error('Private consent did not match the reviewed source.');
                        if (!current() || version !== epoch) {
                            await stop(value, false).catch(() => undefined);
                            throw Error('Private consent retired before it could be saved.');
                        }
                        try {
                            ports.save(value);
                        } catch {
                            await stop(value, false).catch(() => undefined);
                            throw Error('Private access could not be saved; the local stop was requested.');
                        }
                        capability = value;
                        read = null;
                        if (logging) {
                            const enabled = await ports.request('enable', { schema: 1, capability: value.capability });
                            if (!current() || version !== epoch) {
                                await stop(value, false).catch(() => undefined);
                                throw Error('Private activation retired. The original local stop was requested.');
                            }
                            if (
                                !ownBoatRecord(enabled) ||
                                !ownBoatExact(enabled, ['schema', 'state']) ||
                                enabled.schema !== 1 ||
                                enabled.state !== 'logging'
                            )
                                throw Error('Private logging was not confirmed. Read its status or stop it here.');
                        }
                        return value;
                    });
                return operation;
            }),
        read: () =>
            run(async (version) => {
                const cap = capability;
                if (cap && !matches(cap.consent.binding))
                    throw Error(
                        'Stored access belongs to another vessel or revision. Stop it here, or review this vessel to replace it.',
                    );
                if (!cap || !parseOwnBoatCapability(cap, ports.now()))
                    throw Error('Private access expired. Verify the owner and instruments again.');
                if (!read) {
                    const raw = await ports.request('open-read', { schema: 1, capability: cap.capability });
                    guard();
                    if (
                        !ownBoatRecord(raw) ||
                        !ownBoatExact(raw, ['schema', 'readId', 'expiresAt']) ||
                        raw.schema !== 1 ||
                        !ownBoatHex(raw.readId) ||
                        typeof raw.expiresAt !== 'number' ||
                        raw.expiresAt <= ports.now() ||
                        raw.expiresAt > Math.min(cap.consent.expiresAt, ports.now() + LIMIT.readMs)
                    )
                        throw Error('Private read session unavailable.');
                    read = { id: raw.readId, expires: raw.expiresAt, at: ports.now(), mono: ports.monotonic() };
                }
                const r = read;
                if (
                    ports.now() < r.at - 1000 ||
                    ports.now() >= r.expires ||
                    ports.monotonic() < r.mono ||
                    ports.monotonic() - r.mono >= LIMIT.readMs
                )
                    throw Error('Private read session expired. Reopen to read again.');
                const raw = await ports.request('read', { schema: 1, capability: cap.capability, readId: r.id });
                guard();
                if (
                    version !== epoch ||
                    ports.now() >= r.expires ||
                    !ownBoatRecord(raw) ||
                    !ownBoatExact(raw, [
                        'schema',
                        'basis',
                        'generatedAt',
                        'consentRevision',
                        'logging',
                        'phase',
                        'lastMeasuredAt',
                        'scores',
                    ]) ||
                    raw.schema !== 1 ||
                    raw.basis !== 'private-instrument-agreement' ||
                    raw.consentRevision !== cap.consent.revision ||
                    typeof raw.logging !== 'boolean' ||
                    typeof raw.phase !== 'string' ||
                    raw.phase.length > 200 ||
                    typeof raw.generatedAt !== 'number' ||
                    !Number.isSafeInteger(raw.generatedAt) ||
                    Math.abs(raw.generatedAt * 1000 - ports.now()) > 60_000 ||
                    (raw.lastMeasuredAt !== null &&
                        (typeof raw.lastMeasuredAt !== 'number' ||
                            !Number.isSafeInteger(raw.lastMeasuredAt) ||
                            raw.lastMeasuredAt > ports.now() ||
                            raw.lastMeasuredAt < ports.now() - LIMIT.windowMs)) ||
                    !Array.isArray(raw.scores) ||
                    raw.scores.length !== SKILL_LEADS.length
                )
                    throw Error('Private scorecard data is unavailable.');
                const generatedAt = raw.generatedAt;
                return {
                    logging: raw.logging,
                    phase: raw.phase,
                    generatedAt,
                    lastMeasuredAt: raw.lastMeasuredAt as number | null,
                    scores: raw.scores.map((v, i) =>
                        decodeIssuedSkill(v, 'own:' + ports.vesselId, 'wind_speed_mps', SKILL_LEADS[i], generatedAt),
                    ),
                };
            }),
        async off(clear) {
            const old = capability;
            if (!old) throw Error('The original private access is not stored on this phone.');
            // Preserve the old opaque capability until a stop is confirmed so
            // an unreachable Pi can be retried, including after read expiry.
            proposal = null;
            read = null;
            epoch++;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    stop(old, clear),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(Error('The Pi’s local stop could not be confirmed. Retry on boat Wi-Fi.')),
                            LIMIT.operationMs,
                        );
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
            if (capability === old) {
                capability = null;
                ports.save(null);
            }
        },
    };
}
