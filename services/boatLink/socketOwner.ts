/**
 * Who opened the gateway socket — the skipper, the boot of a boat with no Pi,
 * or the instrument policy's fallback while a paired Pi is silent.
 *
 * The policy knows and BoatLinkService needs to know, but the policy also asks
 * BoatLinkService where the phone is. This one-function registry keeps the
 * two from importing each other: the policy registers a reader at boot, and
 * until it does the answer is worked out from the pairing alone.
 */
import type { SocketOwner } from './boatLinkModel';

type OwnerReader = () => SocketOwner;

let reader: OwnerReader | null = null;

export function setSocketOwnerReader(next: OwnerReader | null): void {
    reader = next;
}

/** The registered answer, or null when nothing has registered. */
export function readRegisteredSocketOwner(): SocketOwner | null {
    try {
        return reader ? reader() : null;
    } catch {
        return null;
    }
}
