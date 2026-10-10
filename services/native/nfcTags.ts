/**
 * NFC tags on Ship's Stores boxes (126-11b): the typed wrapper over the native
 * NfcTag plugin (ios/App/App/NfcTagPlugin.swift), and the words for each answer.
 *
 * A tag holds one link, https://www.thalassawx.app/box/<random id>, and
 * nothing else. www, never the apex: Vercel answers every thalassawx.app path
 * with a 307 to www (measured 2026-10-10), and Apple reads no association file
 * behind a redirect, so an apex tag would open Safari instead of Thalassa. The
 * entitlement and the post-deploy check (scripts/verify-web-release.mjs
 * BOX_LINK_ORIGIN) name the same host, and a test keeps the three together.
 *
 * Writing finds the tag, checks it is an NFC Forum tag this iPhone can write
 * (NTAG213, 215 or 216), that it is not locked and that the link fits, writes
 * it, then reads it straight back. Thalassa never locks a tag, so any tag can
 * be rewritten for another box. Loaded with Ship's Stores and the box links
 * (never in the web's first load); NFC is false everywhere but an iPhone with
 * NFC, and the web never calls the plugin.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

/** Every box link starts so; iOS gives the app any link under it (the association file claims /box/*). */
export const BOX_LINK_PREFIX = 'https://www.thalassawx.app/box/';

/** https, this host exactly, /box/ and a UUID: no port, user, query, fragment or more path. */
const BOX_LINK = /^https:\/\/www\.thalassawx\.app\/box\/([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$/;

/**
 * What goes on a box's tag. One URI record with "https://www." as its prefix
 * code: about 63 bytes, so it fits an NTAG213 (144) with room to spare.
 */
export const boxLinkFor = (id: string): string => BOX_LINK_PREFIX + id;

/** The box id in a box link (lower case), or null for anything else. */
export function parseBoxLink(url: unknown): string | null {
    const match = typeof url === 'string' ? BOX_LINK.exec(url) : null;
    return match ? match[1].toLowerCase() : null;
}

export type NfcOutcome =
    | 'written'
    | 'cancelled'
    | 'too_small'
    | 'read_only'
    | 'not_ndef'
    | 'unsupported'
    | 'not_verified'
    | 'failed';

const USE_NTAG = ' Use NTAG213, 215 or 216.';

/** What the skipper is told for each answer. '' says nothing: they closed the iPhone's sheet. */
export const NFC_WORDS: Record<NfcOutcome, string> = {
    written: 'Tag written · hold your iPhone to it to test',
    cancelled: '',
    too_small: 'This tag is too small.' + USE_NTAG,
    read_only: "This tag is locked and can't be rewritten.",
    not_ndef: "This isn't an NFC tag this iPhone can write." + USE_NTAG,
    unsupported: "This iPhone can't read or write NFC tags.",
    not_verified:
        "The tag didn't read back. On aluminium, stainless or any metal a plain sticker may not read: use an anti-metal tag or a plastic spacer.",
    failed: 'The tag moved away. Hold still and try again.',
};

export const NOT_A_BOX_TAG = "This tag isn't a box tag from Thalassa.";

interface NfcTagPlugin {
    isAvailable(): Promise<{ available: boolean }>;
    write(options: { url: string }): Promise<{ outcome: string; tagType?: string }>;
    scan(): Promise<{ outcome: string; url?: string }>;
}

const NfcTag = registerPlugin<NfcTagPlugin>('NfcTag');

const known = (outcome: unknown): NfcOutcome =>
    typeof outcome === 'string' && outcome in NFC_WORDS ? (outcome as NfcOutcome) : 'failed';

let available: Promise<boolean> | null = null;

/** An iPhone with NFC. False on the web and Android without asking, and on an iPad or the simulator. */
export function nfcAvailable(): Promise<boolean> {
    if (Capacitor.getPlatform() !== 'ios') return Promise.resolve(false);
    return (available ??= NfcTag.isAvailable().then(
        (result) => result?.available === true,
        () => false,
    ));
}

/** Write this box's link on the tag held to the iPhone, which reads it straight back. */
export async function writeBoxTag(id: string): Promise<{ outcome: NfcOutcome; words: string }> {
    if (!(await nfcAvailable())) return { outcome: 'unsupported', words: NFC_WORDS.unsupported };
    try {
        const result = await NfcTag.write({ url: boxLinkFor(id) });
        const outcome = known(result?.outcome);
        // The tag's own name, from its GET_VERSION answer, for the smoke test on the packet.
        const type = /^NTAG21[356]$/.test(result?.tagType ?? '') ? ` (${result.tagType})` : '';
        return {
            outcome,
            words: outcome === 'written' ? NFC_WORDS.written.replace('written', `written${type}`) : NFC_WORDS[outcome],
        };
    } catch {
        return { outcome: 'failed', words: NFC_WORDS.failed };
    }
}

/** Read the tag held to the iPhone: its box id, or what to say. */
export async function scanBoxTag(): Promise<{ id: string | null; words: string }> {
    if (!(await nfcAvailable())) return { id: null, words: NFC_WORDS.unsupported };
    try {
        const result = await NfcTag.scan();
        if (result?.outcome === 'read') {
            const id = parseBoxLink(result.url);
            return { id, words: id ? '' : NOT_A_BOX_TAG };
        }
        const outcome = known(result?.outcome);
        return { id: null, words: outcome === 'not_ndef' ? NOT_A_BOX_TAG : NFC_WORDS[outcome] };
    } catch {
        return { id: null, words: NFC_WORDS.failed };
    }
}
