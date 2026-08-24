import React, { FormEvent, useMemo, useRef, useState } from 'react';
import markDark from '../assets/brand/mark-dark.svg';
import {
    APPLE_DEVICES,
    BOAT_TYPES,
    BOATING_FREQUENCIES,
    TESTING_INTERESTS,
    type FoundingSkipperApplication,
    submitFoundingSkipperApplication,
} from './foundingSkipperApplication';

type SubmitApplication = (application: FoundingSkipperApplication) => Promise<void>;
type FieldErrors = Partial<Record<'name' | 'email' | 'boatType' | 'homeWaters' | 'appleDevice' | 'boatingFrequency' | 'interests' | 'consent', string>>;

interface FoundingSkippersPageProps {
    submitApplication?: SubmitApplication;
}

function sourceFromLocation(): string {
    if (typeof window === 'undefined') return 'direct';
    const candidate = new URLSearchParams(window.location.search).get('source')?.trim().toLowerCase() ?? '';
    return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(candidate) ? candidate : 'direct';
}

function validate(values: {
    name: string;
    email: string;
    boatType: string;
    homeWaters: string;
    appleDevice: string;
    boatingFrequency: string;
    interests: string[];
    consent: boolean;
}): FieldErrors {
    const errors: FieldErrors = {};
    if (values.name.trim().length < 2) errors.name = 'Add your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) errors.email = 'Add a valid email address.';
    if (!BOAT_TYPES.some((option) => option.value === values.boatType)) errors.boatType = 'Choose your boat type.';
    if (values.homeWaters.trim().length < 2) errors.homeWaters = 'Add the region where you usually go boating.';
    if (!APPLE_DEVICES.some((option) => option.value === values.appleDevice)) errors.appleDevice = 'Choose your Apple device.';
    if (!BOATING_FREQUENCIES.some((option) => option.value === values.boatingFrequency)) {
        errors.boatingFrequency = 'Tell us roughly how often you get on the water.';
    }
    if (values.interests.length === 0) errors.interests = 'Choose at least one area to test.';
    if (!values.consent) errors.consent = 'Consent is required so we can assess your application and contact you.';
    return errors;
}

function FieldError({ id, children }: { id: string; children?: string }) {
    if (!children) return null;
    return <p id={id} className="beta-field-error">{children}</p>;
}

export function FoundingSkippersPage({
    submitApplication = submitFoundingSkipperApplication,
}: FoundingSkippersPageProps) {
    const source = useMemo(sourceFromLocation, []);
    const sendingRef = useRef(false);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [boatType, setBoatType] = useState('');
    const [homeWaters, setHomeWaters] = useState('');
    const [appleDevice, setAppleDevice] = useState('');
    const [boatingFrequency, setBoatingFrequency] = useState('');
    const [interests, setInterests] = useState<string[]>([]);
    const [notes, setNotes] = useState('');
    const [consent, setConsent] = useState(false);
    const [website, setWebsite] = useState('');
    const [errors, setErrors] = useState<FieldErrors>({});
    const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
    const [submitError, setSubmitError] = useState('');

    const toggleInterest = (value: string) => {
        setInterests((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
        setErrors((current) => ({ ...current, interests: undefined }));
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (sendingRef.current) return;

        const nextErrors = validate({ name, email, boatType, homeWaters, appleDevice, boatingFrequency, interests, consent });
        setErrors(nextErrors);
        setSubmitError('');
        if (Object.keys(nextErrors).length > 0) {
            setStatus('error');
            requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
            return;
        }

        sendingRef.current = true;
        setStatus('sending');
        try {
            await submitApplication({
                name: name.trim(),
                email: email.trim().toLowerCase(),
                boatType: boatType as FoundingSkipperApplication['boatType'],
                homeWaters: homeWaters.trim(),
                appleDevice: appleDevice as FoundingSkipperApplication['appleDevice'],
                boatingFrequency: boatingFrequency as FoundingSkipperApplication['boatingFrequency'],
                interests: interests as FoundingSkipperApplication['interests'],
                notes: notes.trim() || undefined,
                consent: true,
                source,
                website: website.trim() || undefined,
            });
            setStatus('success');
        } catch (error) {
            setStatus('error');
            setSubmitError(error instanceof Error ? error.message : 'We could not send that application. Please try again.');
        } finally {
            sendingRef.current = false;
        }
    };

    return (
        <div className="beta-page">
            <a href="#application" className="beta-skip-link">Skip to application</a>
            <div className="beta-orb beta-orb-one" aria-hidden="true" />
            <div className="beta-orb beta-orb-two" aria-hidden="true" />

            <header className="beta-header">
                <a href="https://www.thalassawx.app" className="beta-brand" aria-label="Thalassa home">
                    <img src={markDark} alt="" draggable={false} />
                    <span>
                        <strong>THALASSA</strong>
                        <small>MARINE DATA &amp; NAVIGATION</small>
                    </span>
                </a>
                <span className="beta-status-pill"><i aria-hidden="true" /> Applications open</span>
            </header>

            <main className="beta-layout">
                <section className="beta-intro" aria-labelledby="beta-heading">
                    <p className="beta-kicker">MORETON BAY · PUBLIC BETA</p>
                    <h1 id="beta-heading">Built for the water.<br /><em>Tested by skippers.</em></h1>
                    <p className="beta-lead">
                        Help shape Thalassa, an Australian-built marine companion for real boats in real conditions.
                        Take it boating, push it hard, and give us straight-up feedback.
                    </p>

                    <div className="beta-feature-grid" aria-label="Features to test">
                        <article><span>01</span><strong>Marine weather</strong><small>Clear conditions and forecasts</small></article>
                        <article><span>02</span><strong>Passage tools</strong><small>Planning and shareable float plans</small></article>
                        <article><span>03</span><strong>Anchor Watch</strong><small>Practical awareness at rest</small></article>
                        <article><span>04</span><strong>Voyage logging</strong><small>Your time on the water, captured</small></article>
                    </div>

                    <aside className="beta-fit-card">
                        <p>YOU'RE A GOOD FIT IF</p>
                        <ul>
                            <li>You regularly get out on a sail or power boat</li>
                            <li>You use an iPhone or iPad on the water</li>
                            <li>You'll tell us what works, what doesn't, and what's missing</li>
                        </ul>
                    </aside>
                </section>

                <section className="beta-form-shell" id="application" aria-labelledby="application-heading">
                    {status === 'success' ? (
                        <div className="beta-success" role="status" aria-live="polite">
                            <div className="beta-success-mark" aria-hidden="true">✓</div>
                            <p className="beta-kicker">APPLICATION RECEIVED</p>
                            <h2>You're on the crew list.</h2>
                            <p>Thanks, {name.trim().split(/\s+/)[0]}. We'll review your application and email you with the next step.</p>
                            <p className="beta-success-note">In the meantime, keep an eye on your inbox and your spam folder.</p>
                        </div>
                    ) : (
                        <>
                            <div className="beta-form-heading">
                                <span>About 60 seconds</span>
                                <h2 id="application-heading">Apply as a Founding Skipper</h2>
                                <p>No account needed. No sales pitch.</p>
                            </div>

                            <form onSubmit={handleSubmit} noValidate>
                                {status === 'error' && (submitError || Object.keys(errors).length > 0) && (
                                    <div className="beta-form-alert" role="alert">
                                        {submitError || 'Check the highlighted fields and have another go.'}
                                    </div>
                                )}

                                <div className="beta-two-up">
                                    <label className="beta-field">
                                        <span>Your name</span>
                                        <input
                                            name="name"
                                            autoComplete="name"
                                            value={name}
                                            onChange={(event) => { setName(event.target.value); setErrors((current) => ({ ...current, name: undefined })); }}
                                            required
                                            maxLength={80}
                                            aria-invalid={Boolean(errors.name)}
                                            aria-describedby={errors.name ? 'name-error' : undefined}
                                            placeholder="Shane Stratton"
                                        />
                                        <FieldError id="name-error">{errors.name}</FieldError>
                                    </label>
                                    <label className="beta-field">
                                        <span>Email</span>
                                        <input
                                            type="email"
                                            name="email"
                                            inputMode="email"
                                            autoComplete="email"
                                            value={email}
                                            onChange={(event) => { setEmail(event.target.value); setErrors((current) => ({ ...current, email: undefined })); }}
                                            required
                                            maxLength={254}
                                            aria-invalid={Boolean(errors.email)}
                                            aria-describedby={errors.email ? 'email-error' : undefined}
                                            placeholder="you@example.com"
                                        />
                                        <FieldError id="email-error">{errors.email}</FieldError>
                                    </label>
                                </div>

                                <div className="beta-two-up">
                                    <label className="beta-field">
                                        <span>Boat type</span>
                                        <select
                                            name="boatType"
                                            value={boatType}
                                            onChange={(event) => { setBoatType(event.target.value); setErrors((current) => ({ ...current, boatType: undefined })); }}
                                            required
                                            aria-invalid={Boolean(errors.boatType)}
                                            aria-describedby={errors.boatType ? 'boat-type-error' : undefined}
                                        >
                                            <option value="">Choose one</option>
                                            {BOAT_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                        </select>
                                        <FieldError id="boat-type-error">{errors.boatType}</FieldError>
                                    </label>
                                    <label className="beta-field">
                                        <span>Apple device</span>
                                        <select
                                            name="appleDevice"
                                            value={appleDevice}
                                            onChange={(event) => { setAppleDevice(event.target.value); setErrors((current) => ({ ...current, appleDevice: undefined })); }}
                                            required
                                            aria-invalid={Boolean(errors.appleDevice)}
                                            aria-describedby={errors.appleDevice ? 'device-error' : undefined}
                                        >
                                            <option value="">Choose one</option>
                                            {APPLE_DEVICES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                        </select>
                                        <FieldError id="device-error">{errors.appleDevice}</FieldError>
                                    </label>
                                </div>

                                <label className="beta-field">
                                    <span>Home waters</span>
                                    <input
                                        name="homeWaters"
                                        autoComplete="off"
                                        value={homeWaters}
                                        onChange={(event) => { setHomeWaters(event.target.value); setErrors((current) => ({ ...current, homeWaters: undefined })); }}
                                        required
                                        maxLength={120}
                                        aria-invalid={Boolean(errors.homeWaters)}
                                        aria-describedby="home-waters-help home-waters-error"
                                        placeholder="Moreton Bay / Gold Coast"
                                    />
                                    <small id="home-waters-help">Region only — don't enter a berth or home address.</small>
                                    <FieldError id="home-waters-error">{errors.homeWaters}</FieldError>
                                </label>

                                <label className="beta-field">
                                    <span>How often are you on the water?</span>
                                    <select
                                        name="boatingFrequency"
                                        value={boatingFrequency}
                                        onChange={(event) => { setBoatingFrequency(event.target.value); setErrors((current) => ({ ...current, boatingFrequency: undefined })); }}
                                        required
                                        aria-invalid={Boolean(errors.boatingFrequency)}
                                        aria-describedby={errors.boatingFrequency ? 'frequency-error' : undefined}
                                    >
                                        <option value="">Choose one</option>
                                        {BOATING_FREQUENCIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                    </select>
                                    <FieldError id="frequency-error">{errors.boatingFrequency}</FieldError>
                                </label>

                                <fieldset className="beta-interests" aria-describedby={errors.interests ? 'interests-error' : undefined}>
                                    <legend>What would you most like to test?</legend>
                                    <p>Pick one or more.</p>
                                    <div>
                                        {TESTING_INTERESTS.map((interest) => (
                                            <label key={interest.value}>
                                                <input
                                                    type="checkbox"
                                                    name="interests"
                                                    value={interest.value}
                                                    checked={interests.includes(interest.value)}
                                                    onChange={() => toggleInterest(interest.value)}
                                                />
                                                <span>{interest.label}</span>
                                            </label>
                                        ))}
                                    </div>
                                    <FieldError id="interests-error">{errors.interests}</FieldError>
                                </fieldset>

                                <label className="beta-field">
                                    <span>Anything we should know? <i>Optional</i></span>
                                    <textarea
                                        name="notes"
                                        value={notes}
                                        onChange={(event) => setNotes(event.target.value)}
                                        maxLength={800}
                                        rows={3}
                                        aria-describedby="notes-help"
                                        placeholder="Your boating background, favourite waters, or the thing marine apps always get wrong…"
                                    />
                                    <small id="notes-help">Don't include passwords, medical details, emergency information, or anyone else's personal information.</small>
                                </label>

                                <div className="beta-honeypot" aria-hidden="true">
                                    <label>Leave this empty<input name="website" value={website} onChange={(event) => setWebsite(event.target.value)} autoComplete="off" tabIndex={-1} /></label>
                                </div>

                                <label className="beta-consent">
                                    <input
                                        type="checkbox"
                                        name="consent"
                                        checked={consent}
                                        onChange={(event) => { setConsent(event.target.checked); setErrors((current) => ({ ...current, consent: undefined })); }}
                                        required
                                        aria-invalid={Boolean(errors.consent)}
                                        aria-describedby="consent-copy consent-error"
                                    />
                                    <span id="consent-copy">I agree that Thalassa may use these details to assess my application and contact me about this beta.</span>
                                </label>
                                <FieldError id="consent-error">{errors.consent}</FieldError>

                                <button type="submit" className="beta-submit" disabled={status === 'sending'}>
                                    {status === 'sending' ? 'Sending application…' : 'Apply to join the crew'}
                                    <span aria-hidden="true">→</span>
                                </button>
                                <p className="beta-privacy">
                                    Protected by a short-lived pseudonymous network limit. We don't store your raw IP. Read our{' '}
                                    <a href="/terms" target="_blank" rel="noreferrer">privacy terms</a>.
                                </p>
                            </form>
                        </>
                    )}
                </section>
            </main>

            <footer className="beta-footer">
                <span>AUSTRALIAN-BUILT · MADE FOR REAL BOATS</span>
                <p>Beta software. Thalassa supplements — and never replaces — official charts, forecasts, seamanship, or independent safety equipment.</p>
            </footer>
        </div>
    );
}
