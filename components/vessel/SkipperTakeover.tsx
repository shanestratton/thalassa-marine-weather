/**
 * The one deliberate takeover of the boat's public page, shared by the Log
 * notice and the Vessel page's skipper card (build 125, 125-12).
 *
 * Shane 2026-10-09, at the marina: "tapping 'Publish from this device' on the
 * Vessel page will fix it - - i cannot find that message??" The Log notice's
 * button only navigated, the card it led to said "Make this phone primary" —
 * and with the Pi primary it offered no button at all. Now both surfaces use
 * the same words and the same confirm, which names the holder and what we
 * actually know about it ("last published 2 hours ago" / "claimed 32 days
 * ago"). Keeping ONE publisher (services/skipperDevice.ts): the confirm is the
 * deliberate act, and it re-checks that the claim it was asked about is still
 * the claim in force before writing.
 *
 * A claim is only ever built once this launch's device id has settled: on a
 * reinstall the Keychain may still be about to hand back the real id, and a
 * claim under the id minted in the meantime would name a device that stops
 * existing a moment later (the trickle awaits the same, deviceIdReady).
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
    buildClaim,
    claimSeenPhrase,
    deviceIdReady,
    deviceIdSettled,
    holdsClaim,
    type SkipperClaim,
} from '../../services/skipperDevice';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';

/** The takeover's name on every surface. */
export const SKIPPER_TAKEOVER_LABEL = 'Publish from this device';

/** "iPad · 77c1 holds your public page — last published 2 hours ago. …" */
export function skipperTakeoverMessage(claim: SkipperClaim): string {
    const holder = claim.deviceName?.trim() || 'Another device';
    return `${holder} holds your public page — ${claimSeenPhrase(claim)}. Taking over stops that device publishing and starts this one.`;
}

interface SkipperTakeoverOptions {
    claim: SkipperClaim | null | undefined;
    authenticatedUserId: string | null | undefined;
    /** Write this device's new claim; called at most once per confirm. */
    apply: (claim: SkipperClaim) => void;
}

/** Run now when the device id has settled, else once the Keychain answers. */
function withSettledDeviceId(task: () => void): void {
    if (deviceIdSettled()) task();
    else void deviceIdReady().then(task, task);
}

export function useSkipperTakeover({ claim, authenticatedUserId, apply }: SkipperTakeoverOptions) {
    const [request, setRequest] = useState<{ scope: AuthIdentityScope; claim: SkipperClaim } | null>(null);
    const inFlight = useRef(false);
    // What is in force when a deferred write finally runs, not when it was asked.
    const latest = useRef({ claim, authenticatedUserId, apply });
    useLayoutEffect(() => {
        latest.current = { claim, authenticatedUserId, apply };
    });
    // "Held here" must use the Keychain id once iOS has answered (a reinstall
    // is the same device), so render again when it has.
    const [, setIdentityKnown] = useState(false);
    useEffect(() => {
        let live = true;
        void deviceIdReady().then(() => {
            if (live) setIdentityKnown(true);
        });
        return () => {
            live = false;
        };
    }, []);

    useEffect(() => {
        inFlight.current = false;
        setRequest(null);
    }, [authenticatedUserId]);
    useEffect(
        () =>
            subscribeAuthIdentityScope(() => {
                inFlight.current = false;
                setRequest(null);
            }),
        [],
    );

    const heldElsewhere = !!claim?.deviceId && !holdsClaim(claim);

    /** Open the confirm. False when there is nothing to take over, or no account to take it for. */
    const ask = useCallback((): boolean => {
        if (inFlight.current || request || !claim?.deviceId || holdsClaim(claim)) return false;
        const scope = getAuthIdentityScope();
        if (!authenticatedUserId || scope.userId !== authenticatedUserId) return false;
        setRequest({ scope, claim });
        return true;
    }, [authenticatedUserId, claim, request]);

    const confirm = useCallback(() => {
        const pending = request;
        if (!pending || inFlight.current) return;
        inFlight.current = true;
        withSettledDeviceId(() => {
            const current = latest.current;
            const stillInForce =
                current.claim?.deviceId === pending.claim.deviceId &&
                current.claim.claimedAt === pending.claim.claimedAt &&
                // The settled id may turn out to be the holder (a reinstall).
                !holdsClaim(current.claim);
            try {
                if (
                    stillInForce &&
                    isAuthIdentityScopeCurrent(pending.scope) &&
                    pending.scope.userId === current.authenticatedUserId
                ) {
                    current.apply(buildClaim());
                }
            } finally {
                setRequest(null);
                queueMicrotask(() => {
                    inFlight.current = false;
                });
            }
        });
    }, [request]);

    /** An unclaimed boat: claim it at a tap, under the settled device id. */
    const claimUnclaimed = useCallback(() => {
        if (inFlight.current) return;
        const scope = getAuthIdentityScope();
        inFlight.current = true;
        withSettledDeviceId(() => {
            const current = latest.current;
            try {
                if (!current.claim?.deviceId && isAuthIdentityScopeCurrent(scope)) current.apply(buildClaim());
            } finally {
                queueMicrotask(() => {
                    inFlight.current = false;
                });
            }
        });
    }, []);

    const cancel = useCallback(() => {
        if (!inFlight.current) setRequest(null);
    }, []);

    const dialog = (
        <ConfirmDialog
            isOpen={request !== null}
            title="Take over skipper publishing?"
            message={request ? skipperTakeoverMessage(request.claim) : ''}
            confirmLabel="Take over"
            onConfirm={confirm}
            onCancel={cancel}
        />
    );

    return {
        ask,
        cancel,
        claimUnclaimed,
        dialog,
        heldElsewhere,
        canTakeOver: heldElsewhere && !!authenticatedUserId,
    };
}
