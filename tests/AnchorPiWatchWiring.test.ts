/**
 * The Pi shore watch is actually reachable from the app.
 *
 * Both halves of this feature were built on 2026-08-29 and neither was
 * connected: services/anchorPiHandoff.ts had no caller anywhere in the app,
 * and the Pi had no /api/anchor/watch route to receive an assignment — so the
 * app posted into nothing and nothing ever posted. Its existing test passed
 * throughout, because it asserts on the module's SOURCE TEXT rather than by
 * calling it, which is exactly how an unreachable feature stays green.
 *
 * These assertions are about REACHABILITY, and they are deliberately
 * end-to-end across the two repos-in-one: a caller in the app, a route on the
 * Pi, and the same path spelled the same way at both ends.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

describe('the Pi can actually be handed the shore watch', () => {
    it('the handoff has a real caller in the app, not only a test', () => {
        const keeper = read('services/anchorPiWatchKeeper.ts');
        expect(keeper).toMatch(/import \{[^}]*handOffToPi[^}]*\} from '\.\/anchorPiHandoff'/);
        expect(keeper).toMatch(/await handOffToPi\(/);
        // …and the keeper itself is reached from the anchor watch screen.
        const page = read('components/AnchorWatchPage.tsx');
        expect(page).toMatch(/import \{[^}]*AnchorPiWatchKeeper[^}]*\} from '\.\.\/services\/anchorPiWatchKeeper'/);
        expect(page).toMatch(/AnchorPiWatchKeeper\.begin\(/);
        expect(page).toMatch(/AnchorPiWatchKeeper\.end\(\)/);
    });

    it('the Pi serves the exact path the app posts to, for both verbs', () => {
        const server = read('pi-cache/src/server.ts');
        const handoff = read('services/anchorPiHandoff.ts');
        // The app builds `${piBaseUrl}/api/anchor/watch`; the Pi must route it.
        expect(handoff).toMatch(/\/api\/anchor\/watch/);
        expect(server).toMatch(/app\.post\('\/api\/anchor\/watch', requireAppApi/);
        expect(server).toMatch(/app\.delete\('\/api\/anchor\/watch', requireAppApi/);
    });

    it('the Pi route drives the broadcaster that was already written for it', () => {
        const server = read('pi-cache/src/server.ts');
        expect(server).toMatch(/import \{[^}]*AnchorWatchRunner[^}]*\} from '\.\/anchorBroadcaster\.js'/);
        expect(server).toMatch(/anchorWatch\.start\(/);
        expect(server).toMatch(/anchorWatch\.stop\(\)/);
    });

    it('the relay endpoint comes from the process trust anchor, never the request body', () => {
        const server = read('pi-cache/src/server.ts');
        // canonicalAnchorRelayEndpoint takes the startup origin; a Boat-LAN
        // caller cannot redirect where the boat's position is published.
        expect(server).toMatch(/canonicalAnchorRelayEndpoint\(SUPABASE_ORIGIN\)/);
        expect(server).not.toMatch(/canonicalAnchorRelayEndpoint\(\s*(?:req|body)/);
        const outbox = read('pi-cache/src/diaryRelayOutbox.ts');
        expect(outbox).toMatch(/const ANCHOR_RELAY_PATH = '\/functions\/v1\/anchor-relay';/);
        expect(outbox).toMatch(/export function canonicalAnchorRelayEndpoint/);
    });

    it('the Pi lends its pairing credential without ever lending the token to the caller', () => {
        const outbox = read('pi-cache/src/diaryRelayOutbox.ts');
        const lend = outbox.slice(outbox.indexOf('lendAnchorCredentials()'));
        expect(lend).toMatch(/return relay \? \{ relayId: relay\.relayId, token: relay\.token \} : null;/);
        // The status payload may describe the watch, but describe() is the only
        // thing exposed — it carries no credential by construction.
        const server = read('pi-cache/src/server.ts');
        expect(server).toMatch(/anchorWatch: anchorWatch\.describe\(\)/);
        expect(server).not.toMatch(/anchorWatch:\s*\{[^}]*token/);
    });

    it('the Pi refuses an assignment it cannot make sense of', () => {
        const server = read('pi-cache/src/server.ts');
        // A 12-character session code, a real latitude and longitude, and an
        // alarm radius that is neither zero (drags on GPS jitter) nor the size
        // of a bay (never drags at all).
        expect(server).toMatch(/ANCHOR_SESSION_CODE_RE = \/\^\[A-Za-z0-9\]\{12\}\$\//);
        expect(server).toMatch(/anchorLat < -90 \|\| anchorLat > 90/);
        expect(server).toMatch(/anchorLon < -180 \|\| anchorLon > 180/);
        expect(server).toMatch(/swingRadius < 5 \|\| swingRadius > 5_000/);
    });

    it('the authorisation is renewed while the watch runs, not granted once', () => {
        const keeper = read('services/anchorPiWatchKeeper.ts');
        expect(keeper).toMatch(/setInterval\(\(\) => void this\.renew\(\), RENEW_INTERVAL_MS\)/);
        // A failed renewal must NOT forget the watch: the phone is still
        // broadcasting and the next interval may well reach the Pi.
        const renew = keeper.slice(keeper.indexOf('private async renew()'));
        expect(renew).not.toMatch(/this\.current = null/);
    });

    it('a Pi that will not take the watch leaves the phone keeping it', () => {
        const keeper = read('services/anchorPiWatchKeeper.ts');
        // Every failure path returns false; nothing here throws into the page.
        expect(keeper).toMatch(/if \(!target\) return false;/);
        expect(keeper).toMatch(/if \(!took\) \{/);
        expect(keeper).not.toMatch(/\bthrow new /);
    });

    it('the offer is only made when the Pi says it can actually keep the watch', () => {
        const server = read('pi-cache/src/server.ts');
        expect(server).toMatch(/app\.get\('\/api\/anchor\/capability', requireAppApi/);
        // Paired, configured, AND seeing the vessel on the bus right now.
        expect(server).toMatch(/capable: paired && !!SUPABASE_ANON_KEY && hasFix/);
        const page = read('components/AnchorWatchPage.tsx');
        expect(page).toMatch(/if \(cancelled\) return;/);
        expect(page).toMatch(/if \(cap\.capable\) setShowPiWatchOffer\(true\);/);
    });

    it('handing over follows the one order that is safe', () => {
        const page = read('components/AnchorWatchPage.tsx');
        const fn = page.slice(page.indexOf('const handleAcceptPiWatch'), page.indexOf('const handleJoinShore'));
        const handoff = fn.indexOf('AnchorPiWatchKeeper.begin(');
        const standDown = fn.indexOf('AnchorWatchService.stopWatch()');
        const becomeShore = fn.indexOf('AnchorWatchSyncService.joinSession(');
        // The Pi must be watching BEFORE this phone stops, or there is a window
        // with nobody watching the boat.
        expect(handoff).toBeGreaterThan(-1);
        expect(standDown).toBeGreaterThan(handoff);
        // And this phone must stop watching BEFORE it goes ashore, or it alarms
        // on its own movement the moment the skipper steps into the dinghy.
        expect(becomeShore).toBeGreaterThan(standDown);
        // A Pi that refuses leaves the phone armed and watching.
        expect(fn).toMatch(/if \(!took\) \{[\s\S]{0,200}still keeping it/);
    });

    it("going ashore does not end the Pi's watch", () => {
        const page = read('components/AnchorWatchPage.tsx');
        // Only weighing the anchor ends it. 'shore' is precisely the state where
        // the Pi is the only thing still watching the boat.
        expect(page).toMatch(/if \(viewMode === 'setup'\) void AnchorPiWatchKeeper\.end\(\)/);
        expect(page).not.toMatch(/viewMode !== 'watching'[\s\S]{0,120}AnchorPiWatchKeeper\.end\(\)/);
    });

    it('offers whenever the Pi can take the watch, not only in the instant after arming', () => {
        const page = read('components/AnchorWatchPage.tsx');
        // Tied to STATE — watching, sharing, no Pi keeping it — so a Pi that is
        // redeployed or comes up while the hook is already down still gets
        // offered. A one-shot probe inside handleSetAnchor could not.
        expect(page).toMatch(/if \(viewMode !== 'watching' \|\| !piOfferAnchorKey\) \{/);
        expect(page).toMatch(
            /if \(AnchorPiWatchKeeper\.isKeeping\(\) \|\| piOfferDeclinedFor === piOfferAnchorKey\) \{/,
        );
        const arm = page.slice(page.indexOf('if (success) {'), page.indexOf('First-time hint dismissal'));
        expect(arm).not.toMatch(/probePiWatchCapability/);
    });

    it('does not ask again once the skipper has said keep it here', () => {
        const page = read('components/AnchorWatchPage.tsx');
        expect(page).toMatch(/setPiOfferDeclinedFor\(piOfferAnchorKey\)/);
    });

    it('the offer renders in the WATCHING view, not the setup one', () => {
        const page = read('components/AnchorWatchPage.tsx');
        // It was first placed beside the setup view's SignInScreen — inside
        // that view's early return — so it was invisible while watching and
        // appeared the instant the anchor was weighed, on a screen with no
        // anchor left to hand over.
        const setupBranch = page.indexOf("if (viewMode === 'setup') {");
        const shoreBranch = page.indexOf("if (viewMode === 'shore') {");
        const dialog = page.indexOf('title="Let the Pi keep the watch?"');
        expect(setupBranch).toBeGreaterThan(-1);
        expect(dialog).toBeGreaterThan(shoreBranch); // past every early return
        // And gated on the view as well as the flag, so a late-resolving probe
        // cannot raise it somewhere it makes no sense.
        expect(page).toMatch(/isOpen=\{showPiWatchOffer && viewMode === 'watching'\}/);
    });

    it('declining is not a dead end — there is a way back to the offer', () => {
        const page = read('components/AnchorWatchPage.tsx');
        // The prompt is asked once per session. Without a second route, "no,
        // keep it here" locked the feature away until the anchor was weighed.
        expect(page).toMatch(/Hand the watch to the Pi/);
        expect(page).toMatch(/setPiOfferDeclinedFor\(null\);\s*setShowPiWatchOffer\(true\);/);
        // The row only appears when the Pi can actually take it and has not.
        expect(page).toMatch(/\{piWatchCapable && !piKeepingWatch && \(/);
    });

    it('capability is probed even when the prompt is suppressed', () => {
        const page = read('components/AnchorWatchPage.tsx');
        // Otherwise the row could never appear for someone who declined, which
        // is exactly the person who needs it.
        const guard = page.slice(page.indexOf('if (AnchorPiWatchKeeper.isKeeping() || piOfferDeclinedFor'));
        expect(guard.slice(0, 400)).toMatch(/probePiWatchCapability/);
    });

    it('the offer does NOT depend on a shore-share session existing', () => {
        // The session is created BY accepting the offer. Gating the offer on
        // it was circular — no session, no probe, no button, no session — and
        // is why nothing appeared on an armed anchor with Shore Share
        // un-started (2026-09-03).
        const page = read('components/AnchorWatchPage.tsx');
        expect(page).not.toMatch(/piOfferSession/);
        expect(page).toMatch(/const piOfferAnchorKey =/);
        expect(page).toMatch(/snapshot\?\.anchorPosition \? String\(snapshot\.anchorPosition\.timestamp\)/);
        // Accepting creates the session itself, so the punter types nothing.
        const accept = page.slice(page.indexOf('const handleAcceptPiWatch'), page.indexOf('const handleJoinShore'));
        expect(accept).toMatch(/await AnchorWatchSyncService\.createSession\(\)/);
    });
});
