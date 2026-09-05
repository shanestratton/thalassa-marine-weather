import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('public-beta privacy contract', () => {
    it('ships pseudonymous crash telemetry without replay, default PII, email, URLs, or precise-location fields', () => {
        const sentry = read('services/sentry.ts');
        const auth = read('stores/authStore.ts');
        const weather = read('services/WeatherOrchestrator.ts');

        expect(sentry).toContain('sendDefaultPii: false');
        expect(sentry).toContain('replaysSessionSampleRate: 0');
        expect(sentry).toContain('replaysOnErrorSampleRate: 0');
        expect(sentry).toContain('stripUrlDetails');
        expect(sentry).toContain('sanitizeTelemetryString');
        expect(sentry).toContain('event.message = sanitizeTelemetryString(event.message)');
        expect(sentry).toContain('exception.value = sanitizeTelemetryString(exception.value)');
        expect(sentry).toContain('SENSITIVE_FIELD');
        expect(sentry).toContain("if (IS_PROD && crumb.category === 'console') return null");
        expect(weather).toContain("message: 'Instant cache hit'");
        expect(weather).toContain("message: 'Weather cache hit'");
        expect(weather).not.toContain('message: `Instant cache hit: ${syncCached.locationName}`');
        expect(weather).not.toContain('message: `Cache HIT: ${cached.locationName}`');
        expect(auth).not.toMatch(/setSentryUser\(\{[^}]*email/);
        expect(weather).not.toMatch(/captureException\([^\n]*location/);
        expect(weather).not.toContain('data: { lat: pos.latitude, lon: pos.longitude }');
    });

    it('states automatic private sync and real data flows instead of device-only promises', () => {
        const terms = read('public/terms.html');
        const normalizedTerms = terms.replace(/\s+/g, ' ');
        const signIn = read('components/SignInScreen.tsx');
        const account = read('components/settings/AccountTab.tsx');

        expect(terms).toContain('Version 2.9 · Public Beta');
        expect(terms).toContain('supported account data syncs');
        expect(terms).toContain('may also be sent to');
        expect(terms).toContain('pseudonymous Thalassa account ID');
        expect(terms).toContain('You can permanently delete your account from within the App');
        // The pre-2.9 'temporarily unavailable' claim must not come back: the flag is
        // on and the backend smoke passed 2026-09-02 — the hosted Terms said otherwise.
        expect(normalizedTerms).not.toContain('temporarily unavailable during this beta');
        expect(normalizedTerms).not.toContain('remains paused');
        expect(terms).toContain('mailto:privacy@thalassawx.com');
        expect(terms).not.toContain('privacy@thalassa.app');
        expect(normalizedTerms).toContain('Once you confirm, deletion cannot be undone');
        expect(terms).toContain('www.thalassawx.app');
        expect(terms).not.toContain('This data cannot be used to identify individual users.');
        expect(signIn).not.toContain('Your data never leaves your boat');
        expect(signIn).toContain('https://www.thalassawx.app/terms.html');
        expect(account).toContain('Automatic private sync');
        expect(account).not.toContain('cloudSyncSettings !== false');
    });

    it('fully discloses the Crew List phone-verification boundary and removal right', () => {
        const terms = read('public/terms.html');
        const normalizedTerms = terms.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        expect(normalizedTerms).toContain('Twilio Verify solely to deliver and check one-time verification codes');
        expect(normalizedTerms).toContain('It is not displayed on your public profile');
        expect(normalizedTerms).toContain('used by Thalassa for marketing');
        expect(normalizedTerms).toContain(
            'Thalassa does not retain the full phone number or one-time code in its database',
        );
        expect(normalizedTerms).toContain(
            'During a verification attempt, the only retained representations of the phone number are the last four digits and a keyed one-way fingerprint',
        );
        expect(normalizedTerms).toContain('Attempt records are automatically deleted within 25 hours');
        expect(normalizedTerms).toContain(
            'After successful verification, those same limited fields form your current verification record and remain until you remove verification or delete your account',
        );
        expect(normalizedTerms).toContain('a Twilio verification reference for security and delivery auditing');
        expect(normalizedTerms).toContain('Twilio separately processes and retains the number');
        expect(normalizedTerms).toContain('cannot be used to recover the number');
        expect(normalizedTerms).toContain('remove the retained phone-verification record at any time');
        expect(normalizedTerms).toContain(
            "Removal immediately deletes Thalassa's stored last four digits, verification-record fingerprint, verification status and time, and provider reference",
        );
        expect(normalizedTerms).toContain(
            "separate opaque keyed quota tokens derived from the number and the request's network address",
        );
        expect(normalizedTerms).toContain('the raw network address is not stored in those records');
        expect(normalizedTerms).toContain(
            'These non-dialable tokens may remain for up to 25 hours after verification removal solely to stop repeated SMS abuse',
        );
        expect(normalizedTerms).toContain(
            'Opaque, non-dialable number- and network-derived keyed abuse-prevention tokens may remain for up to 25 hours after account deletion solely to stop repeated SMS abuse and are then deleted',
        );
        expect(normalizedTerms).toContain('cannot remain published after removal');
        expect(normalizedTerms).toContain(
            'private safety marker containing only your account identifier and the time the marker was created',
        );
        expect(normalizedTerms).toContain(
            'used solely to prevent a former Crew List account from becoming eligible for unsolicited first-contact messages after its profile is removed',
        );
        expect(normalizedTerms).toContain(
            'contains no phone number, phone fingerprint, verification code, profile text, or photograph',
        );
        expect(normalizedTerms).toContain('Deleting your Thalassa account deletes the marker');
    });

    it('discloses automatic Crew List moderation, human fallback, and the no-biometrics boundary', () => {
        const terms = read('public/terms.html');
        const normalizedTerms = terms.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const form = read('components/crew-finder/CrewProfileForm.tsx');

        expect(normalizedTerms).toContain('Crew List Profile Safety Check');
        expect(normalizedTerms).toContain('sent securely to Google Gemini');
        expect(normalizedTerms).toContain('A clearly safe result may publish automatically');
        expect(normalizedTerms).toContain('stays private for a Thalassa administrator to review');
        expect(normalizedTerms).toContain('does not reject or suspend a member by itself');
        expect(normalizedTerms).toContain('does not ask the safety service to identify you');
        expect(normalizedTerms).toContain('perform a liveness check');
        expect(normalizedTerms).toContain('create a facial template or embedding');
        expect(normalizedTerms).toContain('This is content moderation, not identity verification');
        expect(normalizedTerms).toContain(
            'does not copy the profile text, phone number, image bytes, or provider response',
        );
        expect(normalizedTerms).toContain('Request human review');
        expect(form).toContain('No face matching or biometric template');
    });

    /**
     * The consent sheet in NmeaPage makes promises the terms have to back. If
     * the two ever drift, the disclosure a skipper agreed to and the document
     * that governs it stop matching — and the promise that matters most here
     * is the one that cannot be walked back: opting in publishes their own
     * vessel's position irreversibly.
     */
    it('backs the AIS sharing consent sheet with matching terms', () => {
        const terms = read('public/terms.html');
        const normalized = terms.replace(/\s+/g, ' ');
        const sheet = read('components/vessel/NmeaPage.tsx');

        // AISHub must be named as a recipient, not left as "service providers".
        expect(terms).toContain('AISHub');
        expect(normalized).toContain('AISHub operates in the European Union');

        // The irreversibility must be stated in BOTH places.
        expect(normalized).toContain('makes your vessel publicly trackable');
        expect(normalized).toContain('We cannot recall data that has already been redistributed');
        expect(sheet).toContain('Your own boat becomes publicly trackable');

        // Off by default, and separately consented — in both places.
        expect(normalized).toContain('off by default');
        expect(sheet).toContain('Off by default');

        // The receive-only carve-out matters: those skippers publish nothing.
        expect(normalized).toContain('only receives and never transmits');
        expect(sheet).toContain('only receives and never transmits');

        // What is retained, and what is NOT. The absence of a position store
        // is the load-bearing privacy claim of the whole ledger.
        expect(normalized).toContain('does not record your position or any history of it');
        expect(normalized).toContain('deleted when your account is deleted');

        // And the safety floor: contribution must never gate what a skipper
        // can see. If a ration is ever added, this test is where it surfaces.
        expect(normalized).toContain('never affects what AIS, collision warnings, or vessel information you can see');
        expect(sheet).toContain('never rationed, for anyone');
    });

    it('keeps link-shared voyage logs out of search indexes', () => {
        const logs = read('logs.html');
        const middleware = read('middleware.ts');

        expect(logs).toContain('name="robots" content="noindex, nofollow, noarchive"');
        expect(middleware).toContain("headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')");
    });

    it('keeps passive launch and account restore free of permission requests', () => {
        const app = read('App.tsx');
        const controller = read('hooks/useAppController.ts');
        const gps = read('services/GpsService.ts');
        const weather = read('services/WeatherOrchestrator.ts');
        const weatherContext = read('context/WeatherContext.tsx');
        const settings = read('stores/settingsStore.ts');
        const dashboard = read('components/Dashboard.tsx');
        const logPageState = read('hooks/useLogPageState.ts');
        const vesselHub = read('components/VesselHub.tsx');
        const ownship = read('services/ownshipPosition.ts');
        const guardianPage = read('components/GuardianPage.tsx');
        const guardianService = read('services/GuardianService.ts');
        const logPage = read('pages/LogPage.tsx');
        const anchorWatch = read('services/AnchorWatchService.ts');
        const bgGeo = read('services/BgGeoManager.ts');
        const gpsHealthBody = bgGeo.slice(
            bgGeo.indexOf('async getGpsHealth()'),
            bgGeo.indexOf('/** Synchronous last-known health'),
        );
        const samplingBody = bgGeo.slice(
            bgGeo.indexOf('async setSamplingMode('),
            bgGeo.indexOf('/**\n     * Undo a sampling-mode change'),
        );
        const guardianHeartbeat = guardianService.slice(
            guardianService.indexOf('private async sendHeartbeat('),
            guardianService.indexOf('private startHeartbeat('),
        );
        const anchorPreview = anchorWatch.slice(
            anchorWatch.indexOf('async getCurrentPosition()'),
            anchorWatch.indexOf('/**\n     * Restore anchor watch state'),
        );

        expect(app).not.toContain("import('./services/BgGeoManager')");
        expect(app).not.toContain("import('./services/gpsWarmUp')");
        expect(settings).not.toContain('Geolocation.requestPermissions()');
        expect(settings).not.toContain("merged.defaultLocation = 'Current Location'");
        expect(controller).not.toContain('Geolocation.requestPermissions(');
        expect(controller).not.toContain('Geolocation.getCurrentPosition(');
        expect(controller).toContain('GpsService.getCurrentPositionIfGranted(');
        expect(controller).toContain('GpsService.requestCurrentForegroundPosition(');
        expect(gps).toContain('async getCurrentPositionIfGranted(');
        expect(gps).toContain('const permission = await Geolocation.checkPermissions()');
        expect(gps).toContain("if (permission.state !== 'granted') return null");
        expect(gps).toContain('canUseForegroundHighAccuracy(permission, enableHighAccuracy)');
        expect(gps).toContain('if (!ensureRunning) return this._nativeForegroundWatchIfGranted(callback)');
        // Asserted as a PROPERTY, not a literal line (2026-08-07). The
        // privacy guarantee is the ROUTING: a passive watcher — ensureRunning
        // anything but true — must land on _webWatchIfGranted, which cannot
        // raise the OS permission prompt. Pinning the exact spelling made an
        // unrelated rename of the callback variable look like a privacy
        // regression, which trains people to "fix" the test rather than read
        // it. The guarantee below is stricter than the old string: it also
        // fails if the ternary is inverted.
        expect(gps).toMatch(/return opts\.ensureRunning === true \? this\._webWatch\(\s*\w+\s*\)/);
        expect(gps).toMatch(/:\s*this\._webWatchIfGranted\(\s*\w+\s*\)/);
        expect(gps).not.toMatch(/return opts\.ensureRunning === true \? this\._webWatchIfGranted\(/);
        expect(dashboard).not.toContain('useLiveLocationName');
        expect(logPageState).not.toContain('BgGeoManager.ensureReady');
        expect(vesselHub).not.toContain('GpsService.getCurrentPosition(');
        expect(vesselHub).toContain('GpsService.getCurrentPositionIfGranted(');
        expect(gpsHealthBody).not.toContain('ensureReady()');
        expect(bgGeo).toContain('disableMotionActivityUpdates: true');
        expect(samplingBody).toContain('if (!this.ready)');
        expect(samplingBody).not.toContain('ensureReady()');
        expect(ownship).toContain("options.locationAccess ?? 'already-granted'");
        expect(ownship).toContain('GpsService.getCurrentPositionIfGranted(requestOptions)');
        expect(ownship).toContain('GpsService.requestCurrentForegroundPosition(requestOptions)');
        expect(ownship).toContain('GpsService.getCurrentPosition(requestOptions)');
        expect(guardianPage).toContain("locationAccess: 'foreground-request'");
        expect(guardianHeartbeat).not.toContain("locationAccess: 'foreground-request'");
        expect(logPage).toContain("locationAccess: 'background-safety'");
        expect(anchorPreview).toContain('GpsService.getCurrentPositionIfGranted(');
        expect(anchorPreview).not.toContain('BgGeoManager.ensureReady');
        expect(weather).not.toContain('GpsService.getCurrentPosition(');
        expect(weather).toContain('GpsService.getCurrentPositionIfGranted(');
        expect(weatherContext).not.toContain('GpsService.getCurrentPosition(');
        expect(weatherContext).toContain('GpsService.getCurrentPositionIfGranted(');
        // hooks/useSmartRefresh.ts was deleted 2026-09-03 (no importers); the
        // no-prompt-on-passive-refresh contract is still pinned on the live
        // files above.
    });

    it('fails Gmail closed in production until Keychain storage and grant revocation ship', () => {
        const gmail = read('services/voice/integrations/gmail.ts');
        const consoleSource = read('components/voice/BosunConsole.tsx');
        const settings = read('components/settings/CalypsoIntegrationsTab.tsx');

        expect(gmail).toContain('GMAIL_PUBLIC_BETA_ENABLED = import.meta.env.DEV');
        expect(consoleSource).toContain('GMAIL_PUBLIC_BETA_ENABLED && calypsoEmailEnabled');
        expect(settings).toContain('Email access paused for public beta');
    });
});
