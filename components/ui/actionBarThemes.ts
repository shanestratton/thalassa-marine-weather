/**
 * Colour themes shared by SlideToAction and TapToAction, so the slide and tap
 * bars at the foot of a page read as one family. Kept in its own module so a
 * test that mocks SlideToAction does not take the tap bar's colours with it.
 */
export const ACTION_BAR_THEMES = {
    emerald: {
        track: 'linear-gradient(135deg, rgba(16,185,129,0.25) 0%, rgba(5,150,105,0.2) 100%)',
        trackBorder: '1px solid rgba(52,211,153,0.25)',
        shimmer: 'rgba(52,211,153,0.08)',
        shimmerPeak: 'rgba(52,211,153,0.15)',
        labelColor: 'text-emerald-300/70',
        thumbBg: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        thumbShadow: '0 4px 16px rgba(16,185,129,0.4), 0 0 20px rgba(16,185,129,0.15)',
        loadingTrack: 'linear-gradient(135deg, rgba(16,185,129,0.15) 0%, rgba(5,150,105,0.1) 100%)',
        loadingBorder: '1px solid rgba(52,211,153,0.2)',
        spinnerBorder: 'border-emerald-400',
        loadingTextColor: 'text-emerald-300',
    },
    amber: {
        track: 'linear-gradient(135deg, rgba(245,158,11,0.25) 0%, rgba(217,119,6,0.2) 100%)',
        trackBorder: '1px solid rgba(251,191,36,0.25)',
        shimmer: 'rgba(251,191,36,0.08)',
        shimmerPeak: 'rgba(251,191,36,0.15)',
        labelColor: 'text-amber-300/70',
        thumbBg: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
        thumbShadow: '0 4px 16px rgba(245,158,11,0.4), 0 0 20px rgba(245,158,11,0.15)',
        loadingTrack: 'linear-gradient(135deg, rgba(245,158,11,0.15) 0%, rgba(217,119,6,0.1) 100%)',
        loadingBorder: '1px solid rgba(245,158,11,0.2)',
        spinnerBorder: 'border-amber-400',
        loadingTextColor: 'text-amber-300',
    },
    sky: {
        track: 'linear-gradient(135deg, rgba(14,165,233,0.25) 0%, rgba(2,132,199,0.2) 100%)',
        trackBorder: '1px solid rgba(56,189,248,0.25)',
        shimmer: 'rgba(56,189,248,0.08)',
        shimmerPeak: 'rgba(56,189,248,0.15)',
        labelColor: 'text-sky-300/70',
        thumbBg: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)',
        thumbShadow: '0 4px 16px rgba(14,165,233,0.4), 0 0 20px rgba(14,165,233,0.15)',
        loadingTrack: 'linear-gradient(135deg, rgba(14,165,233,0.15) 0%, rgba(2,132,199,0.1) 100%)',
        loadingBorder: '1px solid rgba(56,189,248,0.2)',
        spinnerBorder: 'border-sky-400',
        loadingTextColor: 'text-sky-300',
    },
};
