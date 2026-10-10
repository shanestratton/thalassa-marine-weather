/**
 * The NFC tags on Ship's Stores boxes (126-11b): what goes on a tag, what is
 * read back off one, and what the skipper is told when a tag can't be used.
 *
 * Shane, 2026-10-09: "i have 50 nfc tags ... that i scan the nfc tag which is
 * stuck on the front of the box and it will show me everything that is in that
 * box". 2026-10-10: "NTAG213, 215 or 216 - it must be one of these claude,
 * because i can write to them and read them back". The tag carries only a
 * random box id, never the contents.
 *
 * The native plugin is mocked at the Capacitor boundary. Box ids are random
 * UUIDs made here; the host is www.thalassawx.app, the same in every country.
 * Not the apex thalassawx.app: Vercel answers every apex path with a 307 to
 * www (measured 2026-10-10), and Apple will not read an association file
 * behind a redirect, so a tag holding the apex would open Safari, never the app.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    platform: 'ios',
    plugin: {
        isAvailable: vi.fn(),
        write: vi.fn(),
        scan: vi.fn(),
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => native.platform !== 'web',
        getPlatform: () => native.platform,
        isPluginAvailable: () => false,
    },
    registerPlugin: (name: string) => (name === 'NfcTag' ? native.plugin : {}),
}));

type NfcTags = typeof import('../services/native/nfcTags');

/** A fresh module each time: availability is asked once per launch. */
async function load(platform = 'ios', available = true): Promise<NfcTags> {
    native.platform = platform;
    native.plugin.isAvailable.mockResolvedValue({ available });
    vi.resetModules();
    return import('../services/native/nfcTags');
}

beforeEach(() => {
    native.plugin.isAvailable.mockReset();
    native.plugin.write.mockReset();
    native.plugin.scan.mockReset();
});

describe('the link on a box tag', () => {
    it('is exactly https://www.thalassawx.app/box/<id>, and fits an NTAG213 with room to spare', async () => {
        const { boxLinkFor } = await load();
        const id = randomUUID();
        expect(boxLinkFor(id)).toBe(`https://www.thalassawx.app/box/${id}`);
        // One URI record: 4 header bytes + one prefix code for "https://www." (0x02) + the rest.
        const ndefMessage = 4 + 1 + boxLinkFor(id).length - 'https://www.'.length;
        // Type 2 TLV around it (2) and the terminator (1): ~63 of an NTAG213's 144 bytes.
        expect(ndefMessage + 3).toBeLessThanOrEqual(64);
        // Even written out in full, with no prefix code at all, it is about half an NTAG213.
        expect(4 + 1 + boxLinkFor(id).length + 3).toBeLessThanOrEqual(144 / 2 + 4);
    });

    it('is read back as the box id, in lower case', async () => {
        const { boxLinkFor, parseBoxLink } = await load();
        const id = randomUUID();
        expect(parseBoxLink(boxLinkFor(id))).toBe(id);
        expect(parseBoxLink(boxLinkFor(id.toUpperCase()))).toBe(id);
    });

    it('accepts nothing but that shape', async () => {
        const { parseBoxLink } = await load();
        const id = randomUUID();
        for (const url of [
            `http://www.thalassawx.app/box/${id}`,
            // The apex redirects to www, so iOS can never hand it to the app: not a box link.
            `https://thalassawx.app/box/${id}`,
            `https://www.thalassawx.com/box/${id}`,
            `https://thalassawx.com/box/${id}`,
            `https://evil.thalassawx.app/box/${id}`,
            `https://www.thalassawx.app.example/box/${id}`,
            `https://www.thalassawx.app:8443/box/${id}`,
            `https://skipper@www.thalassawx.app/box/${id}`,
            `https://www.thalassawx.app/box/${id}/x`,
            `https://www.thalassawx.app/box/${id}/`,
            `https://www.thalassawx.app/box/${id}?from=tag`,
            `https://www.thalassawx.app/box/${id}?`,
            `https://www.thalassawx.app/box/${id}#contents`,
            `https://www.thalassawx.app/Box/${id}`,
            `https://www.thalassawx.app/plan/${id}`,
            'https://www.thalassawx.app/box/not-a-box-id',
            `https://www.thalassawx.app/box/${id.slice(0, -1)}`,
            `https://www.thalassawx.app/box/${id}0`,
            ` https://www.thalassawx.app/box/${id}`,
            `com.googleusercontent.apps.example:/oauth2redirect?code=${id}`,
            '',
        ]) {
            expect(parseBoxLink(url), url).toBeNull();
        }
        expect(parseBoxLink(undefined)).toBeNull();
        expect(parseBoxLink(42)).toBeNull();
    });
});

describe('writing a tag', () => {
    it('writes the box link and says what happened, in plain words, for every outcome', async () => {
        const nfc = await load();
        const id = randomUUID();
        const expected: Record<string, string> = {
            written: 'Tag written · hold your iPhone to it to test',
            cancelled: '',
            too_small: 'This tag is too small. Use NTAG213, 215 or 216.',
            read_only: "This tag is locked and can't be rewritten.",
            not_ndef: "This isn't an NFC tag this iPhone can write. Use NTAG213, 215 or 216.",
            unsupported: "This iPhone can't read or write NFC tags.",
        };
        for (const [outcome, words] of Object.entries(expected)) {
            native.plugin.write.mockResolvedValueOnce({ outcome });
            await expect(nfc.writeBoxTag(id)).resolves.toEqual({ outcome, words });
        }
        expect(native.plugin.write).toHaveBeenCalledTimes(Object.keys(expected).length);
        for (const [options] of native.plugin.write.mock.calls) {
            expect(options).toEqual({ url: `https://www.thalassawx.app/box/${id}` });
        }
    });

    it('names the tag it found, and only a tag it knows', async () => {
        const nfc = await load();
        native.plugin.write.mockResolvedValueOnce({ outcome: 'written', tagType: 'NTAG215' });
        await expect(nfc.writeBoxTag(randomUUID())).resolves.toEqual({
            outcome: 'written',
            words: 'Tag written (NTAG215) · hold your iPhone to it to test',
        });
        native.plugin.write.mockResolvedValueOnce({ outcome: 'written', tagType: '<b>anything</b>' });
        await expect(nfc.writeBoxTag(randomUUID())).resolves.toMatchObject({
            words: 'Tag written · hold your iPhone to it to test',
        });
    });

    it('a tag that did not read straight back says so, with the advice for metal boxes', async () => {
        const nfc = await load();
        native.plugin.write.mockResolvedValueOnce({ outcome: 'not_verified' });
        const result = await nfc.writeBoxTag(randomUUID());
        expect(result.outcome).toBe('not_verified');
        expect(result.words).toMatch(/didn't read back/);
        expect(result.words).toMatch(/anti-metal/);
        expect(result.words).toMatch(/plastic spacer/);
    });

    it('an answer it does not know, or a plugin that throws, is a failure, never a success', async () => {
        const nfc = await load();
        native.plugin.write.mockResolvedValueOnce({ outcome: 'locked-forever' });
        await expect(nfc.writeBoxTag(randomUUID())).resolves.toMatchObject({ outcome: 'failed' });
        native.plugin.write.mockRejectedValueOnce(new Error('session already active'));
        const thrown = await nfc.writeBoxTag(randomUUID());
        expect(thrown.outcome).toBe('failed');
        expect(thrown.words).toMatch(/try again/);
    });

    it('never asks the plugin to lock a tag', async () => {
        const nfc = await load();
        native.plugin.write.mockResolvedValue({ outcome: 'written' });
        await nfc.writeBoxTag(randomUUID());
        expect(Object.keys(native.plugin.write.mock.calls[0][0])).toEqual(['url']);
    });
});

describe('scanning a tag', () => {
    it('a box tag gives its box id', async () => {
        const nfc = await load();
        const id = randomUUID();
        native.plugin.scan.mockResolvedValueOnce({ outcome: 'read', url: `https://www.thalassawx.app/box/${id}` });
        await expect(nfc.scanBoxTag()).resolves.toEqual({ id, words: '' });
    });

    it('any other tag gives no id and says so; closing the sheet says nothing', async () => {
        const nfc = await load();
        native.plugin.scan.mockResolvedValueOnce({ outcome: 'read', url: 'https://example.org/menu' });
        await expect(nfc.scanBoxTag()).resolves.toEqual({ id: null, words: "This tag isn't a box tag from Thalassa." });
        native.plugin.scan.mockResolvedValueOnce({ outcome: 'read' });
        await expect(nfc.scanBoxTag()).resolves.toEqual({ id: null, words: "This tag isn't a box tag from Thalassa." });
        native.plugin.scan.mockResolvedValueOnce({ outcome: 'not_ndef' });
        await expect(nfc.scanBoxTag()).resolves.toEqual({ id: null, words: "This tag isn't a box tag from Thalassa." });
        native.plugin.scan.mockResolvedValueOnce({ outcome: 'cancelled' });
        await expect(nfc.scanBoxTag()).resolves.toEqual({ id: null, words: '' });
    });
});

describe('where NFC is', () => {
    it('is false on the web, without touching the plugin, so Write tag and Scan box stay hidden', async () => {
        const nfc = await load('web');
        await expect(nfc.nfcAvailable()).resolves.toBe(false);
        await expect(nfc.writeBoxTag(randomUUID())).resolves.toMatchObject({ outcome: 'unsupported' });
        await expect(nfc.scanBoxTag()).resolves.toMatchObject({ id: null });
        expect(native.plugin.isAvailable).not.toHaveBeenCalled();
        expect(native.plugin.write).not.toHaveBeenCalled();
        expect(native.plugin.scan).not.toHaveBeenCalled();
    });

    it('is false on Android in this build, and on an iPad or the simulator (the plugin says no)', async () => {
        const android = await load('android');
        await expect(android.nfcAvailable()).resolves.toBe(false);
        expect(native.plugin.isAvailable).not.toHaveBeenCalled();

        const ipad = await load('ios', false);
        await expect(ipad.nfcAvailable()).resolves.toBe(false);
        await expect(ipad.writeBoxTag(randomUUID())).resolves.toMatchObject({ outcome: 'unsupported' });
        expect(native.plugin.write).not.toHaveBeenCalled();
    });

    it('asks the iPhone once, and a plugin that is missing reads as no NFC', async () => {
        const nfc = await load();
        await expect(nfc.nfcAvailable()).resolves.toBe(true);
        await expect(nfc.nfcAvailable()).resolves.toBe(true);
        expect(native.plugin.isAvailable).toHaveBeenCalledTimes(1);

        native.platform = 'ios';
        native.plugin.isAvailable.mockRejectedValue(new Error('"NfcTag" plugin is not implemented on ios'));
        vi.resetModules();
        const missing = await import('../services/native/nfcTags');
        await expect(missing.nfcAvailable()).resolves.toBe(false);
    });
});
