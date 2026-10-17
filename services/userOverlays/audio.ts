import { AlarmAudioService } from '../AlarmAudioService';
let audio: AudioContext | null = null;
let current: { osc: OscillatorNode; gain: GainNode; timer: ReturnType<typeof setInterval> } | null = null;
/** Called only from an explicit entry-alert toggle. No background/native alarm. */
export async function unlockOverlayChime() {
    try {
        audio ??= new AudioContext();
        if (audio.state === 'suspended') await audio.resume();
    } catch {
        /* banner remains available */
    }
}
export function stopOverlayChime() {
    if (current) {
        clearInterval(current.timer);
        try {
            current.osc.stop();
        } catch {
            /* already ended */
        }
        current = null;
    }
}
/** One short low-volume cue, never layered over an owned safety alarm. */
export function playOverlayChime(): boolean {
    if (
        !audio ||
        audio.state !== 'running' ||
        AlarmAudioService.getIsPlaying() ||
        document.visibilityState !== 'visible'
    )
        return false;
    stopOverlayChime();
    const osc = audio.createOscillator(),
        gain = audio.createGain(),
        at = audio.currentTime;
    osc.frequency.setValueAtTime(660, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.06, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    osc.connect(gain).connect(audio.destination);
    const timer = setInterval(() => {
        if (AlarmAudioService.getIsPlaying() || document.visibilityState !== 'visible') stopOverlayChime();
    }, 50);
    current = { osc, gain, timer };
    osc.onended = () => {
        clearInterval(timer);
        osc.disconnect();
        gain.disconnect();
        if (current?.osc === osc) current = null;
    };
    osc.start(at);
    osc.stop(at + 0.4);
    return true;
}
