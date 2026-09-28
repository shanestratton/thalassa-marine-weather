import React from 'react';
import { Button } from './Button';
import { NeedsIPhoneAppNotice } from './UnavailableNotice';

/**
 * Honest replacement for every Pi setup/control surface, on builds that cannot
 * verify the Pi. No Pi discovery, setup, chart or control call is made from
 * this screen.
 *
 * Since 2026-08-06 this is no longer a beta-wide hold — the Pi is available to
 * any build carrying the native certificate-pinning transport. What this screen
 * now says is narrower and more useful: THIS build cannot check that the box
 * answering `calypso.local` is your Pi, so it will not talk to it. The web
 * build is the ordinary case (browsers do not expose the peer certificate to
 * script, so nothing there can verify the pin).
 *
 * Skipper words, not build words: "unavailable in this build" and "Pi
 * integration" read as developer-speak (UX scorecard run 6), so the heading
 * says what to use instead. It wears the shared "needs the iPhone app" look
 * (sky, phone glyph), not an amber padlock: nothing is wrong, it is simply
 * the wrong device (UX scorecard run 7).
 */
export const PiPublicBetaUnavailable: React.FC<{ onOpenEncLibrary?: () => void }> = ({ onOpenEncLibrary }) => (
    // The one step the skipper can take leads the body; the why follows it.
    // 'What still works here' sits directly over the chart library button, so
    // the button reads as that, not as the pairing step (UX scorecard run 8).
    <NeedsIPhoneAppNotice
        title="Boat network needs the Thalassa iPhone app"
        note="Weather, charts and the diary still work here."
        actions={
            onOpenEncLibrary && (
                <Button variant="secondary" onClick={onOpenEncLibrary} className="text-white">
                    Open chart library
                </Button>
            )
        }
    >
        {/* The last words are held together with non-breaking spaces so 'Pi.'
            never sits alone on the last line (UX scorecard run 10, avnav-orphan). */}
        <p>
            Open Thalassa on your iPhone, on the boat&rsquo;s Wi-Fi, to pair with the Pi. Only the iPhone app can check
            that it is talking to your own&nbsp;boat&rsquo;s&nbsp;Pi.
        </p>
    </NeedsIPhoneAppNotice>
);
