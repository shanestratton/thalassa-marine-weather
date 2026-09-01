import React, { useEffect, useMemo, useRef } from 'react';

import type { CrewPhoneVerificationController } from '../../hooks/useCrewPhoneVerification';

const PHONE_COUNTRIES = [
    { iso: 'AU', dial: '+61', name: 'Australia' },
    { iso: 'NZ', dial: '+64', name: 'New Zealand' },
    { iso: 'VU', dial: '+678', name: 'Vanuatu' },
    { iso: 'FJ', dial: '+679', name: 'Fiji' },
    { iso: 'NC', dial: '+687', name: 'New Caledonia' },
    { iso: 'PG', dial: '+675', name: 'Papua New Guinea' },
    { iso: 'SB', dial: '+677', name: 'Solomon Islands' },
    { iso: 'WS', dial: '+685', name: 'Samoa' },
    { iso: 'TO', dial: '+676', name: 'Tonga' },
    { iso: 'ID', dial: '+62', name: 'Indonesia' },
    { iso: 'SG', dial: '+65', name: 'Singapore' },
    { iso: 'MY', dial: '+60', name: 'Malaysia' },
    { iso: 'PH', dial: '+63', name: 'Philippines' },
    { iso: 'TH', dial: '+66', name: 'Thailand' },
    { iso: 'VN', dial: '+84', name: 'Vietnam' },
    { iso: 'JP', dial: '+81', name: 'Japan' },
    { iso: 'IN', dial: '+91', name: 'India' },
    { iso: 'AE', dial: '+971', name: 'United Arab Emirates' },
    { iso: 'ZA', dial: '+27', name: 'South Africa' },
    { iso: 'GB', dial: '+44', name: 'United Kingdom' },
    { iso: 'IE', dial: '+353', name: 'Ireland' },
    { iso: 'FR', dial: '+33', name: 'France' },
    { iso: 'DE', dial: '+49', name: 'Germany' },
    { iso: 'NL', dial: '+31', name: 'Netherlands' },
    { iso: 'ES', dial: '+34', name: 'Spain' },
    { iso: 'PT', dial: '+351', name: 'Portugal' },
    { iso: 'IT', dial: '+39', name: 'Italy' },
    { iso: 'GR', dial: '+30', name: 'Greece' },
    { iso: 'HR', dial: '+385', name: 'Croatia' },
    { iso: 'TR', dial: '+90', name: 'Türkiye' },
    { iso: 'US', dial: '+1', name: 'United States' },
    { iso: 'CA', dial: '+1', name: 'Canada' },
] as const;

interface CrewPhoneVerificationPanelProps {
    controller: CrewPhoneVerificationController;
}

export const CrewPhoneVerificationPanel: React.FC<CrewPhoneVerificationPanelProps> = ({ controller }) => {
    const codeInputRef = useRef<HTMLInputElement>(null);
    const [confirmNumberChange, setConfirmNumberChange] = React.useState(false);
    const selectedCountry = useMemo(
        () => PHONE_COUNTRIES.find((country) => country.iso === controller.countryCode) ?? PHONE_COUNTRIES[0],
        [controller.countryCode],
    );
    const accountCheckPending = controller.publicationState === 'checking';
    const accountCheckUnavailable = controller.publicationState === 'unavailable';

    useEffect(() => {
        if (controller.pending) codeInputRef.current?.focus();
    }, [controller.pending]);

    useEffect(() => {
        if (!controller.status?.verified) setConfirmNumberChange(false);
    }, [controller.status?.verified]);

    const submitPhone = (event: React.FormEvent) => {
        event.preventDefault();
        void controller.start();
    };

    const submitCode = (event: React.FormEvent) => {
        event.preventDefault();
        void controller.check();
    };

    return (
        <section
            aria-labelledby="crew-mobile-verification-title"
            className="rounded-3xl border border-cyan-400/20 bg-linear-to-br from-cyan-500/10 via-slate-900 to-emerald-500/8 p-4 shadow-lg shadow-cyan-950/20"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200/65">Trust check</p>
                    <h3 id="crew-mobile-verification-title" className="mt-1 text-base font-black text-white">
                        Verify your mobile
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-white/55">
                        One quick SMS helps keep scammers out. Your number is never shown on your Crew List profile.
                    </p>
                </div>
                <span aria-hidden="true" className="text-2xl">
                    🛡️
                </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2" aria-label="Crew List verification status">
                <span
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${accountCheckPending || accountCheckUnavailable ? 'border-white/10 bg-white/4 text-white/45' : controller.status?.emailVerified ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-amber-400/20 bg-amber-500/10 text-amber-100'}`}
                >
                    {accountCheckPending
                        ? '… Checking email'
                        : accountCheckUnavailable
                          ? '? Email unknown'
                          : controller.status?.emailVerified
                            ? '✓ Email verified'
                            : '○ Email needed'}
                </span>
                <span
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${accountCheckPending || accountCheckUnavailable ? 'border-white/10 bg-white/4 text-white/45' : controller.status?.verified ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : controller.pending ? 'border-sky-400/25 bg-sky-500/10 text-sky-100' : 'border-amber-400/20 bg-amber-500/10 text-amber-100'}`}
                >
                    {accountCheckPending
                        ? '… Checking mobile'
                        : accountCheckUnavailable
                          ? '? Mobile unknown'
                          : controller.status?.verified
                            ? '✓ Mobile verified'
                            : controller.pending
                              ? '• Code sent'
                              : '○ Mobile needed'}
                </span>
            </div>

            <div aria-live="polite" className="mt-4">
                {!controller.signedIn ? (
                    <p className="rounded-2xl border border-amber-400/15 bg-amber-500/8 p-3 text-xs text-amber-100/80">
                        Sign in from Vessel → Settings → Account before verifying your mobile.
                    </p>
                ) : accountCheckPending ? (
                    <div className="flex min-h-[52px] items-center gap-3 text-sm text-white/55">
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-cyan-300/20 border-t-cyan-300" />
                        Checking verification…
                    </div>
                ) : accountCheckUnavailable ? (
                    <div className="space-y-3 rounded-2xl border border-amber-400/15 bg-amber-500/8 p-3">
                        <p className="text-xs leading-relaxed text-amber-100/80">
                            We could not confirm your trust checks. Your profile has not been changed.
                        </p>
                        <button
                            type="button"
                            onClick={() => void controller.refresh()}
                            className="min-h-[44px] w-full rounded-xl border border-cyan-400/25 bg-cyan-500/15 px-3 text-xs font-bold text-cyan-100"
                        >
                            Retry trust check
                        </button>
                    </div>
                ) : controller.status?.verified ? (
                    <div className="space-y-3">
                        <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-3.5">
                            <p className="text-sm font-bold text-emerald-100">Mobile verified</p>
                            <p className="mt-1 text-xs text-emerald-100/65">
                                Number ending •••• {controller.status.last4}. Only the final four digits are shown here.
                            </p>
                            {!controller.status.emailVerified && (
                                <p className="mt-2 text-xs text-amber-100/80">
                                    Verify your account email before publishing this profile.
                                </p>
                            )}
                        </div>
                        {confirmNumberChange ? (
                            <div className="rounded-2xl border border-amber-400/20 bg-amber-500/8 p-3">
                                <p className="text-xs font-bold text-amber-100">Change this verified number?</p>
                                <p className="mt-1 text-xs leading-relaxed text-white/55">
                                    This immediately takes your Crew List profile private. It stays private until your
                                    new mobile is verified and the profile is ready again.
                                </p>
                                <div className="mt-3 grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setConfirmNumberChange(false)}
                                        disabled={controller.removing}
                                        className="min-h-[44px] rounded-xl border border-white/10 bg-white/4 px-2 text-xs font-bold text-white/65 disabled:opacity-45"
                                    >
                                        Keep current number
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setConfirmNumberChange(false);
                                            void controller.remove();
                                        }}
                                        disabled={controller.removing}
                                        className="min-h-[44px] rounded-xl border border-amber-400/25 bg-amber-500/15 px-2 text-xs font-bold text-amber-100 disabled:opacity-45"
                                    >
                                        {controller.removing ? 'Making profile private…' : 'Make private & change'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setConfirmNumberChange(true)}
                                className="min-h-[44px] w-full rounded-xl px-3 text-xs font-bold text-white/45 underline decoration-white/20 underline-offset-4"
                            >
                                Change verified number
                            </button>
                        )}
                    </div>
                ) : controller.pending ? (
                    <form onSubmit={submitCode} className="space-y-3">
                        <p className="text-xs leading-relaxed text-sky-100/75">
                            Enter the six-digit code sent to the mobile ending •••• {controller.pending.last4}.
                        </p>
                        <div>
                            <label htmlFor="crew-mobile-code" className="mb-1.5 block text-xs font-bold text-white/65">
                                Six-digit verification code
                            </label>
                            <input
                                ref={codeInputRef}
                                id="crew-mobile-code"
                                value={controller.code}
                                onChange={(event) => controller.setCode(event.target.value)}
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                pattern="[0-9]{6}"
                                maxLength={6}
                                placeholder="000000"
                                aria-describedby="crew-mobile-code-help"
                                className="min-h-[48px] w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-center font-mono text-xl tracking-[0.42em] text-white placeholder:text-white/20 focus:border-cyan-400/50 focus:outline-hidden"
                            />
                            <p id="crew-mobile-code-help" className="mt-1.5 text-[11px] text-white/40">
                                The code expires shortly. Standard SMS charges may apply.
                            </p>
                        </div>
                        <button
                            type="submit"
                            disabled={controller.checking || controller.code.length !== 6}
                            className="min-h-[46px] w-full rounded-2xl bg-linear-to-r from-emerald-500 to-cyan-600 px-4 text-sm font-black text-white shadow-lg shadow-cyan-950/30 transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {controller.checking ? 'Checking code…' : 'Verify mobile'}
                        </button>
                        <div className="flex items-center justify-between gap-3">
                            <button
                                type="button"
                                onClick={() => void controller.resend()}
                                disabled={controller.starting || controller.cooldownSeconds > 0}
                                className="min-h-[44px] rounded-xl px-2 text-xs font-bold text-cyan-200 disabled:text-white/30"
                            >
                                {controller.cooldownSeconds > 0
                                    ? `Resend in ${controller.cooldownSeconds}s`
                                    : controller.starting
                                      ? 'Sending…'
                                      : 'Resend code'}
                            </button>
                            <button
                                type="button"
                                onClick={controller.changeNumber}
                                className="min-h-[44px] rounded-xl px-2 text-xs font-bold text-white/55"
                            >
                                Change number
                            </button>
                        </div>
                    </form>
                ) : (
                    <form onSubmit={submitPhone} className="space-y-3">
                        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] gap-2">
                            <div>
                                <label
                                    htmlFor="crew-mobile-country"
                                    className="mb-1.5 block text-xs font-bold text-white/65"
                                >
                                    Country
                                </label>
                                <select
                                    id="crew-mobile-country"
                                    value={controller.countryCode}
                                    onChange={(event) => controller.setCountryCode(event.target.value)}
                                    className="min-h-[48px] w-full rounded-2xl border border-white/10 bg-slate-950/70 px-3 text-sm text-white focus:border-cyan-400/50 focus:outline-hidden"
                                >
                                    {PHONE_COUNTRIES.map((country) => (
                                        <option key={country.iso} value={country.iso}>
                                            {country.name} {country.dial}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label
                                    htmlFor="crew-mobile-number"
                                    className="mb-1.5 block text-xs font-bold text-white/65"
                                >
                                    Mobile number
                                </label>
                                <div className="relative">
                                    <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-cyan-200/70">
                                        {selectedCountry.dial}
                                    </span>
                                    <input
                                        id="crew-mobile-number"
                                        type="tel"
                                        inputMode="tel"
                                        autoComplete="tel-national"
                                        value={controller.localNumber}
                                        onChange={(event) => controller.setLocalNumber(event.target.value)}
                                        placeholder="0412 345 678"
                                        aria-describedby="crew-mobile-number-help"
                                        className="min-h-[48px] w-full rounded-2xl border border-white/10 bg-slate-950/70 py-3 pl-14 pr-3 text-sm text-white placeholder:text-white/25 focus:border-cyan-400/50 focus:outline-hidden"
                                    />
                                </div>
                            </div>
                        </div>
                        <p id="crew-mobile-number-help" className="text-[11px] leading-relaxed text-white/40">
                            Enter your local mobile number. The country code is added securely for the SMS.
                        </p>
                        <button
                            type="submit"
                            disabled={
                                controller.starting ||
                                controller.cooldownSeconds > 0 ||
                                controller.localNumber.replace(/\D/g, '').length < 5
                            }
                            className="min-h-[46px] w-full rounded-2xl border border-cyan-400/25 bg-cyan-500/15 px-4 text-sm font-black text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {controller.starting
                                ? 'Sending secure code…'
                                : controller.cooldownSeconds > 0
                                  ? `Try again in ${controller.cooldownSeconds}s`
                                  : 'Send verification code'}
                        </button>
                    </form>
                )}
            </div>

            {controller.error && (
                <p
                    role="alert"
                    className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-100"
                >
                    {controller.error}
                </p>
            )}
        </section>
    );
};
