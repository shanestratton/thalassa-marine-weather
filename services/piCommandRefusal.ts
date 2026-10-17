/**
 * Her Pi said no to this phone (129-12): only her own devices can command it.
 *
 * From Pi update 4 the boat's Pi can answer a state-changing call only from a
 * phone or tablet it enrolled (pi-cache/src/piCommandLock.ts), once the
 * skipper turns that on. A refusal is 403 with `{ code, error }`:
 *   pi-device-not-set-up  "This phone isn't set up for <boat>'s Pi. Type the code from her Pi."
 *   pi-device-removed     "This phone was removed from <boat>'s Pi. Type a new code from her Pi."
 * PiPairingService drops a removed device's token wherever it is refused. The
 * words are said where this phone's own command was refused, never for a call
 * it made in the background (the Pi settings push, the diary relay): the
 * night watch link (a stand-down, the test push), the anchor watch hand-off
 * (hand over, stop, move) and the boat track recorder's switch note it here,
 * and the AIS key's watch row, the anchor page and the recorder card say it;
 * the Pi settings row says it from the Pi's own status read. The boat is named
 * from the pairing, never a hard-coded name. A failure is blamed on a refusal
 * only when one was noted since its own command went (`sinceMs`).
 *
 * Reads, the watch state and raising an alarm are never refused, so a phone
 * that is not set up still sees every watch and still raises alarms (its
 * acknowledgement silences this phone only, while her Pi enforces). The note
 * goes when this phone is set up, when it pairs with another Pi, or 15 minutes
 * after the last refusal (a code lasts as long).
 */

export const PI_COMMAND_REFUSAL_CODES = ['pi-device-not-set-up', 'pi-device-removed'] as const;
const SAID_FOR_MS = 15 * 60_000;

let said: { removed: boolean; boat: string; at: number } | null = null;
const listeners = new Set<() => void>();

const emit = () => {
    for (const listener of listeners) {
        try {
            listener();
        } catch {
            /* one display must not keep the word from the others */
        }
    }
};

/** The lock's refusal code in a Pi answer, or null (any other answer, or another refusal). */
export function piCommandRefusalCode(res: { status: number; data?: unknown }): string | null {
    if (res.status !== 403) return null;
    try {
        const code = (JSON.parse(String(res.data)) as { code?: unknown } | null)?.code;
        return (PI_COMMAND_REFUSAL_CODES as readonly unknown[]).includes(code) ? (code as string) : null;
    } catch {
        return null;
    }
}

/** The words for a refusal, naming the boat. */
export function piRefusalWords(code: string, boatName?: string): string {
    const boat = boatName?.trim() || 'your boat';
    return code === 'pi-device-removed'
        ? `This phone was removed from ${boat}'s Pi. Type a new code from her Pi.`
        : `This phone isn't set up for ${boat}'s Pi. Type the code from her Pi.`;
}

/** Her Pi refused a command this phone made just now. */
export function notePiCommandRefusal(code: string, boatName?: string): void {
    said = { removed: code === 'pi-device-removed', boat: boatName ?? '', at: Date.now() };
    emit();
}

/** Note it when this answer is the lock's refusal (the boat asked for only then); its code, or null. */
export function notePiCommandRefusalIn(
    res: { status: number; data?: unknown },
    boatName: () => string | undefined,
): string | null {
    const code = piCommandRefusalCode(res);
    if (code) notePiCommandRefusal(code, boatName());
    return code;
}

/** This phone was set up, or paired with another Pi: what the last Pi said no longer holds. */
export function clearPiCommandRefusal(): void {
    if (!said) return;
    said = null;
    emit();
}

/**
 * The words for the latest refusal, or null when there is none to say.
 * `sinceMs`: only a refusal noted since then (a command this phone just made),
 * so an older one is never blamed for another failure.
 */
export function piCommandRefusalWords(nowMs = Date.now(), sinceMs = -Infinity): string | null {
    if (!said || nowMs - said.at > SAID_FOR_MS || said.at < sinceMs) return null;
    return piRefusalWords(said.removed ? 'pi-device-removed' : 'pi-device-not-set-up', said.boat);
}

export function onPiCommandRefusal(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
