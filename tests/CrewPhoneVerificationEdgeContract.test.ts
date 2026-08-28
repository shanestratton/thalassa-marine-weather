import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const index = readFileSync('supabase/functions/crew-phone-verification/index.ts', 'utf8');
const protocol = readFileSync('supabase/functions/crew-phone-verification/protocol.ts', 'utf8');
const twilio = readFileSync('supabase/functions/crew-phone-verification/twilio.ts', 'utf8');
const config = readFileSync('supabase/config.toml', 'utf8');

describe('Crew phone-verification Edge contract', () => {
    it('pins the protected function and implements only status, start, and check', () => {
        expect(config).toMatch(/\[functions\.crew-phone-verification\][\s\S]*?verify_jwt\s*=\s*true/i);
        expect(protocol).toMatch(/value === 'status' \|\| value === 'start' \|\| value === 'check'/i);
        expect(protocol).not.toMatch(/value === '(?:revoke|remove|admin)'/i);
        expect(index).toMatch(/readJsonObject\(req, 2_048\)/i);
        expect(index).toMatch(/req\.method !== 'POST'/i);
    });

    it('matches the client response and fixed public-error shapes', () => {
        expect(index).toMatch(
            /verified:\s*status\.verified === true,[\s\S]*?last4:[\s\S]*?verifiedAt:[\s\S]*?emailVerified:/i,
        );
        expect(index).toMatch(/status:\s*'pending',[\s\S]*?last4:[\s\S]*?retryAfterSeconds:\s*60,[\s\S]*?expiresAt/i);
        expect(index).toMatch(/verified:\s*true,[\s\S]*?last4:[\s\S]*?verifiedAt:/i);
        expect(index).toMatch(/interface PublicError[\s\S]*?error: string;[\s\S]*?code: string;/i);
        expect(index).toMatch(/retryAfterSeconds\?: number/i);
    });

    it('keeps Twilio and HMAC secrets server-only and authenticates the real caller', () => {
        expect(twilio).toContain("env.get('TWILIO_API_KEY_SID')");
        expect(twilio).toContain("env.get('TWILIO_API_KEY_SECRET')");
        expect(twilio).toContain("env.get('TWILIO_VERIFY_SERVICE_SID')");
        expect(index).toContain("Deno.env.get('CREW_PHONE_HMAC_KEY')");
        expect(index).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
        expect(`${index}\n${twilio}`).not.toMatch(/VITE_(?:TWILIO|CREW_PHONE|SUPABASE_SERVICE_ROLE)/i);
        expect(index).toMatch(/client\.auth\.getUser\(\)/i);
        expect(index).toMatch(/Boolean\(user\.email_confirmed_at\)/i);
        expect(index).not.toMatch(/body\.user_?id/i);
    });

    it('uses Lookup canonical E.164 and Verify SID checks through bounded direct fetches', () => {
        expect(protocol).toContain(String.raw`const PHONE_INPUT = /^[+0-9().\s-]{5,32}$/`);
        expect(protocol).toContain(String.raw`const E164 = /^\+[1-9][0-9]{7,14}$/`);
        expect(protocol).toContain(String.raw`const OTP = /^[0-9]{6}$/`);
        expect(twilio).toContain('https://lookups.twilio.com/v2/PhoneNumbers/');
        expect(twilio).toContain('https://verify.twilio.com/v2/Services/');
        expect(twilio).toMatch(/new URLSearchParams\(\{ VerificationSid: verificationSid, Code: code \}\)/i);
        expect(twilio).not.toMatch(/new URLSearchParams\(\{[^}]*To:[^}]*Code:/i);
        expect(twilio).toMatch(/readResponseJsonObjectLimited\(response, 65_536\)/i);
        expect(twilio).toMatch(/setTimeout\(\(\) => controller\.abort\(\), 12_000\)/i);
        expect(protocol).not.toMatch(/headers\.get\(['"]x-forwarded-for['"]\)/i);
    });

    it('maps blocked, unsupported, fraud, and messaging-limit Verify failures to stable public outcomes', () => {
        for (const code of [60205, 60238, 60412]) {
            expect(twilio).toContain(`error.providerCode === ${code}`);
        }
        expect(twilio).toContain('error.providerCode === 60245');
        expect(index).toMatch(/case 'sms_unavailable':[\s\S]*?'SMS_UNAVAILABLE', 400/i);
        expect(index).toMatch(/case 'rate_limited':[\s\S]*?'RATE_LIMITED', 429, 60/i);
        expect(`${index}\n${twilio}`).not.toMatch(/error\.message|body\.message/i);
    });

    it('registers a secret key tag before any user, IP, or phone HMAC is used', () => {
        expect(index).toMatch(/keyedFingerprint\(hmacSecret, 'crew-phone-key-tag', HMAC_KEY_SENTINEL\)/i);
        expect(index).toMatch(
            /admin\.rpc\('assert_crew_phone_hmac_key',[\s\S]*?p_hmac_version: PHONE_HMAC_VERSION,[\s\S]*?p_key_tag: keyTag/i,
        );
        expect(index).toMatch(/if \(keyError \|\| keyAccepted !== true\)[\s\S]*?'SERVER_CONFIG', 503/i);
        expect(index.indexOf("'assert_crew_phone_hmac_key'")).toBeLessThan(
            index.indexOf("keyedFingerprint(hmacSecret, 'crew-phone-user'"),
        );
        expect(index).not.toMatch(/p_(?:secret|hmac_key):\s*hmacSecret/i);
    });

    it('persists only HMAC/last4/SID metadata and rate-limits user, IP, and number', () => {
        expect(index).toMatch(/keyedFingerprint\(hmacSecret, 'crew-phone-number', e164\)/i);
        expect(index).toMatch(/keyedFingerprint\(hmacSecret, 'crew-phone-user', authenticated\.userId\)/i);
        expect(index).toMatch(/keyedFingerprint\(hmacSecret, 'crew-phone-ip', address\)/i);
        expect(index).toContain("'crew_phone_start_10m'");
        expect(index).toContain("'crew_phone_number_10m'");
        expect(index).toContain("'crew_phone_ip_hour'");

        const reservation = index.match(
            /admin\.rpc\(\s*'reserve_crew_phone_verification_attempt',[\s\S]*?\n\s*\);/i,
        )?.[0];
        expect(reservation).toBeTruthy();
        expect(reservation).toContain('p_phone_hmac: phoneHash');
        expect(reservation).toContain('p_phone_last4: lastFour(e164)');
        expect(reservation).not.toMatch(/p_(?:phone|code):/i);
        expect(index).not.toMatch(/console\.(?:log|info|warn|error)/i);
    });

    it('uses only the owner-safe and service-role transaction RPC surface', () => {
        expect(index).toContain("authenticated.client.rpc('get_current_crew_phone_status')");
        for (const rpc of [
            'assert_crew_phone_hmac_key',
            'reserve_crew_phone_verification_attempt',
            'activate_crew_phone_verification_attempt',
            'fail_crew_phone_verification_attempt',
            'claim_crew_phone_verification_check',
            'complete_crew_phone_verification',
        ]) {
            expect(index).toContain(`'${rpc}'`);
        }
        expect(index).not.toMatch(/\.from\(['"]crew_phone_(?:identities|verification_attempts)['"]\)/i);
    });

    it('does not let a concurrent provider 404 expire another request that already won approval', () => {
        const providerCatch = index.match(
            /checkedStatus = \(await checkVerification[\s\S]*?catch \(error\) \{[\s\S]*?if \(error instanceof TwilioProviderError\) \{([\s\S]*?)return providerPublicError\(error\);/i,
        )?.[1];
        expect(providerCatch).toBeTruthy();
        expect(providerCatch).not.toMatch(/markAttempt|fail_crew_phone_verification_attempt/i);
        expect(providerCatch).toMatch(/concurrent double tap/i);
    });
});
