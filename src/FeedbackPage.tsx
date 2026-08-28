import React, { FormEvent, useMemo, useRef, useState } from 'react';
import markDark from '../assets/brand/mark-dark.svg';
import {
    appContextFromLocation,
    BUG_IMPACTS,
    createClientSubmissionId,
    captureFeedbackDiagnostics,
    FEEDBACK_AREAS,
    FEATURE_IMPACTS,
    kindFromLocation,
    PRODUCT_FEEDBACK_CONSENT_VERSION,
    sourceFromLocation,
    submitProductFeedback,
    type FeedbackArea,
    type FeedbackImpact,
    type FeedbackKind,
    type FeedbackSubmission,
    type FeedbackSubmissionReceipt,
} from './feedbackSubmission';

type SubmitFeedback = (submission: FeedbackSubmission) => Promise<FeedbackSubmissionReceipt>;
type FieldName =
    | 'name'
    | 'email'
    | 'area'
    | 'title'
    | 'details'
    | 'impact'
    | 'stepsToReproduce'
    | 'expectedResult'
    | 'actualResult'
    | 'problemToSolve'
    | 'idealOutcome'
    | 'device'
    | 'appVersion'
    | 'consent';
type FieldErrors = Partial<Record<FieldName, string>>;

interface FeedbackPageProps {
    submitFeedback?: SubmitFeedback;
}

interface FormValues {
    name: string;
    email: string;
    area: string;
    title: string;
    details: string;
    impact: string;
    stepsToReproduce: string;
    expectedResult: string;
    actualResult: string;
    problemToSolve: string;
    idealOutcome: string;
    device: string;
    appVersion: string;
    consent: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function hasInlineControl(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
    });
}

function hasMultilineControl(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127;
    });
}

function normalizedInline(value: string): string {
    return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function normalizedMultiline(value: string): string {
    return value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

function lengthError(value: string, min: number, max: number, message: string, multiline = false): string | undefined {
    const normalized = multiline ? normalizedMultiline(value) : normalizedInline(value);
    const hasControl = multiline ? hasMultilineControl(normalized) : hasInlineControl(normalized);
    return normalized.length < min || normalized.length > max || hasControl ? message : undefined;
}

function validate(kind: FeedbackKind, values: FormValues): FieldErrors {
    const errors: FieldErrors = {};
    errors.name = lengthError(values.name, 2, 80, 'Add your name.');

    const email = normalizedInline(values.email).toLowerCase();
    if (email.length < 3 || email.length > 254 || hasInlineControl(email) || !EMAIL_PATTERN.test(email)) {
        errors.email = 'Add a valid email address.';
    }

    if (!FEEDBACK_AREAS.some((option) => option.value === values.area)) errors.area = 'Choose the part of Thalassa.';
    errors.title = lengthError(values.title, 5, 120, 'Give it a short title (at least 5 characters).');
    errors.details = lengthError(values.details, 20, 4_000, 'Add a little more detail (at least 20 characters).', true);

    const impacts = kind === 'bug' ? BUG_IMPACTS : FEATURE_IMPACTS;
    if (!impacts.some((option) => option.value === values.impact)) errors.impact = 'Tell us how much this matters.';

    for (const [field, value, max] of [
        ['stepsToReproduce', values.stepsToReproduce, 2_000],
        ['expectedResult', values.expectedResult, 2_000],
        ['actualResult', values.actualResult, 2_000],
        ['problemToSolve', values.problemToSolve, 2_000],
        ['idealOutcome', values.idealOutcome, 2_000],
    ] as const) {
        if (value && lengthError(value, 0, max, 'Keep this under 2,000 characters.', true)) {
            errors[field] = 'Keep this under 2,000 characters.';
        }
    }

    if (kind === 'feature') {
        errors.problemToSolve = lengthError(
            values.problemToSolve,
            5,
            2_000,
            'Tell us what problem this would solve.',
            true,
        );
        errors.idealOutcome = lengthError(
            values.idealOutcome,
            5,
            2_000,
            'Describe what a great version would do.',
            true,
        );
    }

    if (values.device && lengthError(values.device, 0, 120, 'Keep the device name under 120 characters.')) {
        errors.device = 'Keep the device name under 120 characters.';
    }
    if (values.appVersion && lengthError(values.appVersion, 0, 40, 'Keep the version under 40 characters.')) {
        errors.appVersion = 'Keep the version under 40 characters.';
    }
    if (!values.consent) errors.consent = 'Please agree so we can receive and respond to your feedback.';

    return Object.fromEntries(Object.entries(errors).filter(([, message]) => Boolean(message)));
}

function FieldError({ id, children }: { id: string; children?: string }) {
    if (!children) return null;
    return (
        <p id={id} className="feedback-field-error">
            {children}
        </p>
    );
}

function OptionalLabel({ children }: { children: React.ReactNode }) {
    return (
        <span>
            {children} <i>Optional</i>
        </span>
    );
}

export function FeedbackPage({ submitFeedback = submitProductFeedback }: FeedbackPageProps) {
    const source = useMemo(sourceFromLocation, []);
    const appLinkContext = useMemo(appContextFromLocation, []);
    const [kind, setKind] = useState<FeedbackKind>(() => kindFromLocation());
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [area, setArea] = useState('');
    const [title, setTitle] = useState('');
    const [details, setDetails] = useState('');
    const [impact, setImpact] = useState('');
    const [stepsToReproduce, setStepsToReproduce] = useState('');
    const [expectedResult, setExpectedResult] = useState('');
    const [actualResult, setActualResult] = useState('');
    const [problemToSolve, setProblemToSolve] = useState('');
    const [idealOutcome, setIdealOutcome] = useState('');
    const [device, setDevice] = useState('');
    const [appVersion, setAppVersion] = useState(appLinkContext.appVersion);
    const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
    const [consent, setConsent] = useState(false);
    const [website, setWebsite] = useState('');
    const [errors, setErrors] = useState<FieldErrors>({});
    const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
    const [submitError, setSubmitError] = useState('');
    const [reference, setReference] = useState('');
    const sendingRef = useRef(false);
    const submissionIdRef = useRef<string | null>(null);

    const clearError = (field: FieldName) => setErrors((current) => ({ ...current, [field]: undefined }));

    const chooseKind = (nextKind: FeedbackKind) => {
        setKind(nextKind);
        setImpact('');
        setIncludeDiagnostics(false);
        setErrors((current) => ({
            ...current,
            impact: undefined,
            problemToSolve: undefined,
            idealOutcome: undefined,
        }));
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (sendingRef.current) return;

        const values: FormValues = {
            name,
            email,
            area,
            title,
            details,
            impact,
            stepsToReproduce,
            expectedResult,
            actualResult,
            problemToSolve,
            idealOutcome,
            device,
            appVersion,
            consent,
        };
        const nextErrors = validate(kind, values);
        setErrors(nextErrors);
        setSubmitError('');
        if (Object.keys(nextErrors).length > 0) {
            setStatus('error');
            requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
            return;
        }

        sendingRef.current = true;
        setStatus('sending');
        submissionIdRef.current ??= createClientSubmissionId();
        const submission: FeedbackSubmission = {
            clientSubmissionId: submissionIdRef.current,
            kind,
            name: normalizedInline(name),
            email: normalizedInline(email).toLowerCase(),
            area: area as FeedbackArea,
            title: normalizedInline(title),
            details: normalizedMultiline(details),
            impact: impact as FeedbackImpact,
            stepsToReproduce: kind === 'bug' ? normalizedMultiline(stepsToReproduce) : '',
            expectedResult: kind === 'bug' ? normalizedMultiline(expectedResult) : '',
            actualResult: kind === 'bug' ? normalizedMultiline(actualResult) : '',
            problemToSolve: kind === 'feature' ? normalizedMultiline(problemToSolve) : '',
            idealOutcome: kind === 'feature' ? normalizedMultiline(idealOutcome) : '',
            device: kind === 'bug' ? normalizedInline(device) : '',
            appVersion: normalizedInline(appVersion),
            appBuild: appLinkContext.appBuild,
            appPlatform: appLinkContext.appPlatform,
            diagnostics: kind === 'bug' && includeDiagnostics ? captureFeedbackDiagnostics() : null,
            source,
            consent: true,
            consentVersion: PRODUCT_FEEDBACK_CONSENT_VERSION,
            website: website.trim(),
        };

        try {
            const receipt = await submitFeedback(submission);
            setReference(receipt.reference);
            setStatus('success');
        } catch (error) {
            setStatus('error');
            setSubmitError(
                error instanceof Error ? error.message : 'We could not send that feedback. Please try again.',
            );
        } finally {
            sendingRef.current = false;
        }
    };

    const impacts = kind === 'bug' ? BUG_IMPACTS : FEATURE_IMPACTS;
    const appContextSummary = [
        appLinkContext.appPlatform,
        appLinkContext.appVersion
            ? /^v/iu.test(appLinkContext.appVersion)
                ? appLinkContext.appVersion
                : `v${appLinkContext.appVersion}`
            : '',
        appLinkContext.appBuild ? `build ${appLinkContext.appBuild}` : '',
    ].filter(Boolean);

    return (
        <div className="feedback-page">
            <a href="#feedback-form" className="feedback-skip-link">
                Skip to feedback form
            </a>
            <div className="feedback-orb feedback-orb-one" aria-hidden="true" />
            <div className="feedback-orb feedback-orb-two" aria-hidden="true" />

            <header className="feedback-header">
                <a href="/" className="feedback-brand" aria-label="Thalassa home">
                    <img src={markDark} alt="" draggable={false} />
                    <span>
                        <strong>THALASSA</strong>
                        <small>THE SAILOR'S ASSISTANT</small>
                    </span>
                </a>
                <span className="feedback-status-pill">
                    <i aria-hidden="true" /> Feedback channel open
                </span>
            </header>

            <main className="feedback-layout">
                <section className="feedback-intro" aria-labelledby="feedback-heading">
                    <p className="feedback-kicker">STRAIGHT TO THE BUILD CREW</p>
                    <h1 id="feedback-heading">
                        Found a rough edge?
                        <br />
                        <em>Tell us straight.</em>
                    </h1>
                    <p className="feedback-lead">
                        Bugs, bright ideas, and the little things that drive you mad — send them directly to the people
                        building Thalassa.
                    </p>

                    <div className="feedback-route-cards" aria-label="Ways to help improve Thalassa">
                        <article>
                            <span aria-hidden="true">↯</span>
                            <div>
                                <strong>Something broke</strong>
                                <small>Tell us what happened and where.</small>
                            </div>
                        </article>
                        <article>
                            <span aria-hidden="true">✦</span>
                            <div>
                                <strong>Something could be better</strong>
                                <small>Tell us the problem your idea solves.</small>
                            </div>
                        </article>
                    </div>

                    <aside className="feedback-good-report">
                        <p>THE MOST USEFUL REPORTS INCLUDE</p>
                        <ul>
                            <li>What you were trying to do</li>
                            <li>What happened instead</li>
                            <li>Whether it stopped you on the water</li>
                        </ul>
                        <small>No need to write an essay. Plain sailor's English is perfect.</small>
                    </aside>
                </section>

                <section className="feedback-form-shell" id="feedback-form" aria-labelledby="feedback-form-heading">
                    {status === 'success' ? (
                        <div className="feedback-success" role="status" aria-live="polite">
                            <div className="feedback-success-mark" aria-hidden="true">
                                ✓
                            </div>
                            <p className="feedback-kicker">SAFELY ABOARD</p>
                            <h2>Report received.</h2>
                            <p>
                                Thanks, {normalizedInline(name).split(/\s+/u)[0]}. A receipt is on its way to{' '}
                                <strong>{normalizedInline(email).toLowerCase()}</strong>.
                            </p>
                            <p className="feedback-reference">Reference: {reference}</p>
                            <p className="feedback-success-note">
                                Have a screenshot or short screen recording? Reply to the receipt email with screenshots
                                or attachments — they will stay connected to this report.
                            </p>
                            <a href="/feedback" className="feedback-again-link">
                                Send another report
                            </a>
                        </div>
                    ) : (
                        <>
                            <div className="feedback-form-heading">
                                <span>Usually under 2 minutes</span>
                                <h2 id="feedback-form-heading">Help us make Thalassa better</h2>
                                <p>No account needed. Every useful report gets read.</p>
                            </div>

                            <form onSubmit={handleSubmit} noValidate>
                                {status === 'error' && (submitError || Object.keys(errors).length > 0) && (
                                    <div className="feedback-form-alert" role="alert">
                                        {submitError || 'Check the highlighted fields and have another go.'}
                                    </div>
                                )}

                                {appContextSummary.length > 0 && (
                                    <aside className="feedback-app-context" aria-label="Report context from app link">
                                        <span aria-hidden="true">↗</span>
                                        <div>
                                            <small>FROM THE APP LINK</small>
                                            <strong>{appContextSummary.join(' · ')}</strong>
                                            <p>
                                                These details came from the app link and will be attached to this
                                                report.
                                            </p>
                                        </div>
                                    </aside>
                                )}

                                <fieldset
                                    className="feedback-kind"
                                    role="radiogroup"
                                    aria-describedby="feedback-kind-help"
                                >
                                    <legend>What are you sending?</legend>
                                    <p id="feedback-kind-help">Choose the closest fit.</p>
                                    <div>
                                        <label>
                                            <input
                                                type="radio"
                                                name="kind"
                                                value="bug"
                                                aria-label="Report a bug"
                                                checked={kind === 'bug'}
                                                onChange={() => chooseKind('bug')}
                                            />
                                            <span>
                                                <b aria-hidden="true">↯</b>
                                                <strong>Report a bug</strong>
                                                <small>Something isn't working right</small>
                                            </span>
                                        </label>
                                        <label>
                                            <input
                                                type="radio"
                                                name="kind"
                                                value="feature"
                                                aria-label="Request a feature"
                                                checked={kind === 'feature'}
                                                onChange={() => chooseKind('feature')}
                                            />
                                            <span>
                                                <b aria-hidden="true">✦</b>
                                                <strong>Request a feature</strong>
                                                <small>An idea that would help on board</small>
                                            </span>
                                        </label>
                                    </div>
                                </fieldset>

                                <div className="feedback-two-up">
                                    <label className="feedback-field">
                                        <span>Your name</span>
                                        <input
                                            name="name"
                                            aria-label="Your name"
                                            autoComplete="name"
                                            value={name}
                                            onChange={(event) => {
                                                setName(event.target.value);
                                                clearError('name');
                                            }}
                                            required
                                            maxLength={80}
                                            aria-invalid={Boolean(errors.name)}
                                            aria-describedby={errors.name ? 'feedback-name-error' : undefined}
                                        />
                                        <FieldError id="feedback-name-error">{errors.name}</FieldError>
                                    </label>
                                    <label className="feedback-field">
                                        <span>Email</span>
                                        <input
                                            type="email"
                                            name="email"
                                            aria-label="Email"
                                            inputMode="email"
                                            autoComplete="email"
                                            value={email}
                                            onChange={(event) => {
                                                setEmail(event.target.value);
                                                clearError('email');
                                            }}
                                            required
                                            maxLength={254}
                                            aria-invalid={Boolean(errors.email)}
                                            aria-describedby="feedback-email-help feedback-email-error"
                                        />
                                        <small id="feedback-email-help">
                                            For the receipt and any follow-up questions.
                                        </small>
                                        <FieldError id="feedback-email-error">{errors.email}</FieldError>
                                    </label>
                                </div>

                                <label className="feedback-field">
                                    <span>Area of Thalassa</span>
                                    <select
                                        name="area"
                                        aria-label="Area of Thalassa"
                                        value={area}
                                        onChange={(event) => {
                                            setArea(event.target.value);
                                            clearError('area');
                                        }}
                                        required
                                        aria-invalid={Boolean(errors.area)}
                                        aria-describedby={errors.area ? 'feedback-area-error' : undefined}
                                    >
                                        <option value="">Choose one</option>
                                        {FEEDBACK_AREAS.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                    <FieldError id="feedback-area-error">{errors.area}</FieldError>
                                </label>

                                <label className="feedback-field">
                                    <span>Short title</span>
                                    <input
                                        name="title"
                                        aria-label="Short title"
                                        value={title}
                                        onChange={(event) => {
                                            setTitle(event.target.value);
                                            clearError('title');
                                        }}
                                        required
                                        maxLength={120}
                                        aria-invalid={Boolean(errors.title)}
                                        aria-describedby="feedback-title-count feedback-title-error"
                                    />
                                    <small id="feedback-title-count">{title.length}/120</small>
                                    <FieldError id="feedback-title-error">{errors.title}</FieldError>
                                </label>

                                <label className="feedback-field">
                                    <span>Details</span>
                                    <textarea
                                        name="details"
                                        aria-label="Details"
                                        value={details}
                                        onChange={(event) => {
                                            setDetails(event.target.value);
                                            clearError('details');
                                        }}
                                        required
                                        maxLength={4_000}
                                        rows={5}
                                        aria-invalid={Boolean(errors.details)}
                                        aria-describedby="feedback-details-help feedback-details-count feedback-details-error"
                                        placeholder={
                                            kind === 'bug'
                                                ? 'What were you doing, and what went wrong?'
                                                : 'What would you like Thalassa to do?'
                                        }
                                    />
                                    <span className="feedback-field-meta">
                                        <small id="feedback-details-help">
                                            Don't include passwords or emergency information.
                                        </small>
                                        <small id="feedback-details-count">{details.length}/4000</small>
                                    </span>
                                    <FieldError id="feedback-details-error">{errors.details}</FieldError>
                                </label>

                                <fieldset
                                    className="feedback-impact"
                                    role="radiogroup"
                                    aria-describedby={`feedback-impact-help${errors.impact ? ' feedback-impact-error' : ''}`}
                                    aria-invalid={Boolean(errors.impact)}
                                >
                                    <legend>Impact</legend>
                                    <p id="feedback-impact-help">
                                        {kind === 'bug'
                                            ? 'How badly did this get in your way?'
                                            : 'How useful would this be?'}
                                    </p>
                                    <div>
                                        {impacts.map((option) => (
                                            <label key={option.value}>
                                                <input
                                                    type="radio"
                                                    name="impact"
                                                    value={option.value}
                                                    aria-label={option.label}
                                                    checked={impact === option.value}
                                                    onChange={() => {
                                                        setImpact(option.value);
                                                        clearError('impact');
                                                    }}
                                                />
                                                <span>{option.label}</span>
                                            </label>
                                        ))}
                                    </div>
                                    <FieldError id="feedback-impact-error">{errors.impact}</FieldError>
                                </fieldset>

                                {kind === 'bug' ? (
                                    <div className="feedback-conditional" aria-label="Bug details">
                                        <p className="feedback-section-label">HELP US REPRODUCE IT</p>
                                        <label className="feedback-field">
                                            <OptionalLabel>Steps to reproduce</OptionalLabel>
                                            <textarea
                                                name="stepsToReproduce"
                                                aria-label="Steps to reproduce"
                                                value={stepsToReproduce}
                                                onChange={(event) => {
                                                    setStepsToReproduce(event.target.value);
                                                    clearError('stepsToReproduce');
                                                }}
                                                maxLength={2_000}
                                                rows={3}
                                                aria-invalid={Boolean(errors.stepsToReproduce)}
                                                aria-describedby={
                                                    errors.stepsToReproduce ? 'feedback-steps-error' : undefined
                                                }
                                                placeholder={'1. Open…\n2. Tap…\n3. See…'}
                                            />
                                            <FieldError id="feedback-steps-error">{errors.stepsToReproduce}</FieldError>
                                        </label>
                                        <div className="feedback-two-up">
                                            <label className="feedback-field">
                                                <OptionalLabel>What did you expect?</OptionalLabel>
                                                <textarea
                                                    name="expectedResult"
                                                    aria-label="What did you expect?"
                                                    value={expectedResult}
                                                    onChange={(event) => {
                                                        setExpectedResult(event.target.value);
                                                        clearError('expectedResult');
                                                    }}
                                                    maxLength={2_000}
                                                    rows={3}
                                                    aria-invalid={Boolean(errors.expectedResult)}
                                                    aria-describedby={
                                                        errors.expectedResult ? 'feedback-expected-error' : undefined
                                                    }
                                                />
                                                <FieldError id="feedback-expected-error">
                                                    {errors.expectedResult}
                                                </FieldError>
                                            </label>
                                            <label className="feedback-field">
                                                <OptionalLabel>What actually happened?</OptionalLabel>
                                                <textarea
                                                    name="actualResult"
                                                    aria-label="What actually happened?"
                                                    value={actualResult}
                                                    onChange={(event) => {
                                                        setActualResult(event.target.value);
                                                        clearError('actualResult');
                                                    }}
                                                    maxLength={2_000}
                                                    rows={3}
                                                    aria-invalid={Boolean(errors.actualResult)}
                                                    aria-describedby={
                                                        errors.actualResult ? 'feedback-actual-error' : undefined
                                                    }
                                                />
                                                <FieldError id="feedback-actual-error">
                                                    {errors.actualResult}
                                                </FieldError>
                                            </label>
                                        </div>
                                        <div className="feedback-two-up">
                                            <label className="feedback-field">
                                                <OptionalLabel>Device</OptionalLabel>
                                                <input
                                                    name="device"
                                                    aria-label="Device"
                                                    value={device}
                                                    onChange={(event) => {
                                                        setDevice(event.target.value);
                                                        clearError('device');
                                                    }}
                                                    maxLength={120}
                                                    aria-invalid={Boolean(errors.device)}
                                                    aria-describedby={
                                                        errors.device ? 'feedback-device-error' : undefined
                                                    }
                                                    placeholder="e.g. iPhone 15 Pro"
                                                />
                                                <FieldError id="feedback-device-error">{errors.device}</FieldError>
                                            </label>
                                            <label className="feedback-field">
                                                <OptionalLabel>Thalassa version</OptionalLabel>
                                                <input
                                                    name="appVersion"
                                                    aria-label="Thalassa version"
                                                    value={appVersion}
                                                    readOnly={Boolean(appLinkContext.appVersion)}
                                                    onChange={(event) => {
                                                        setAppVersion(event.target.value);
                                                        clearError('appVersion');
                                                    }}
                                                    maxLength={40}
                                                    aria-invalid={Boolean(errors.appVersion)}
                                                    aria-describedby="feedback-version-help feedback-version-error"
                                                />
                                                <small id="feedback-version-help">
                                                    {appLinkContext.appVersion
                                                        ? 'Added by the app link and locked to this report.'
                                                        : "Shown in the app's information panel."}
                                                </small>
                                                <FieldError id="feedback-version-error">{errors.appVersion}</FieldError>
                                            </label>
                                        </div>

                                        <label className="feedback-diagnostics">
                                            <input
                                                type="checkbox"
                                                name="includeDiagnostics"
                                                aria-label="Include basic technical details"
                                                checked={includeDiagnostics}
                                                onChange={(event) => setIncludeDiagnostics(event.target.checked)}
                                            />
                                            <span>
                                                <strong>Include basic technical details</strong>
                                                <small>
                                                    Optional and off by default. Includes browser, operating platform,
                                                    screen and viewport size, language, online status, and this page's
                                                    path. Never your location, IP, cookies, account data, device ID, or
                                                    URL parameters.
                                                </small>
                                            </span>
                                        </label>
                                    </div>
                                ) : (
                                    <div className="feedback-conditional" aria-label="Feature details">
                                        <p className="feedback-section-label">MAKE THE CASE</p>
                                        <label className="feedback-field">
                                            <span>What problem would this solve?</span>
                                            <textarea
                                                name="problemToSolve"
                                                aria-label="What problem would this solve?"
                                                value={problemToSolve}
                                                onChange={(event) => {
                                                    setProblemToSolve(event.target.value);
                                                    clearError('problemToSolve');
                                                }}
                                                required
                                                maxLength={2_000}
                                                rows={3}
                                                aria-invalid={Boolean(errors.problemToSolve)}
                                                aria-describedby={
                                                    errors.problemToSolve ? 'feedback-problem-error' : undefined
                                                }
                                            />
                                            <FieldError id="feedback-problem-error">{errors.problemToSolve}</FieldError>
                                        </label>
                                        <label className="feedback-field">
                                            <span>What would a great version look like?</span>
                                            <textarea
                                                name="idealOutcome"
                                                aria-label="What would a great version look like?"
                                                value={idealOutcome}
                                                onChange={(event) => {
                                                    setIdealOutcome(event.target.value);
                                                    clearError('idealOutcome');
                                                }}
                                                required
                                                maxLength={2_000}
                                                rows={3}
                                                aria-invalid={Boolean(errors.idealOutcome)}
                                                aria-describedby={
                                                    errors.idealOutcome ? 'feedback-outcome-error' : undefined
                                                }
                                            />
                                            <FieldError id="feedback-outcome-error">{errors.idealOutcome}</FieldError>
                                        </label>
                                    </div>
                                )}

                                <div className="feedback-honeypot" aria-hidden="true">
                                    <label>
                                        Leave this empty
                                        <input
                                            name="website"
                                            value={website}
                                            onChange={(event) => setWebsite(event.target.value)}
                                            autoComplete="off"
                                            tabIndex={-1}
                                        />
                                    </label>
                                </div>

                                <label className="feedback-consent">
                                    <input
                                        type="checkbox"
                                        name="consent"
                                        checked={consent}
                                        onChange={(event) => {
                                            setConsent(event.target.checked);
                                            clearError('consent');
                                        }}
                                        required
                                        aria-invalid={Boolean(errors.consent)}
                                        aria-describedby="feedback-consent-copy feedback-consent-error"
                                    />
                                    <span id="feedback-consent-copy">
                                        I agree that Thalassa may use these details to investigate this report, improve
                                        the product, email me a receipt, and contact me about this feedback.
                                    </span>
                                </label>
                                <FieldError id="feedback-consent-error">{errors.consent}</FieldError>

                                <p className="feedback-privacy">
                                    Your report and contact details are kept private. Resend processes email delivery
                                    for your receipt and our operator notification, which may enter a private monitored
                                    inbox. Basic diagnostics are optional and off by default; we don't store your raw
                                    IP. We don't sell feedback data or use it for advertising. Don't include passwords,
                                    one-time codes, authentication tokens, private chart files, or another person's
                                    personal information. Read our{' '}
                                    <a href="/terms" target="_blank" rel="noreferrer">
                                        privacy terms
                                    </a>
                                    .
                                </p>

                                <button type="submit" className="feedback-submit" disabled={status === 'sending'}>
                                    {status === 'sending'
                                        ? 'Sending safely…'
                                        : kind === 'bug'
                                          ? 'Send bug report'
                                          : 'Send feature request'}
                                    <span aria-hidden="true">→</span>
                                </button>
                                <p className="feedback-screenshot-note">
                                    Screenshots aren't uploaded here. After submitting, reply to your receipt email to
                                    attach them securely to the report.
                                </p>
                            </form>
                        </>
                    )}
                </section>
            </main>

            <footer className="feedback-footer">
                <span>AUSTRALIAN-BUILT · MADE FOR REAL BOATS</span>
                <p>
                    For an immediate danger or emergency, use official maritime and emergency channels — this form is
                    not monitored as an emergency service.
                </p>
            </footer>
        </div>
    );
}
