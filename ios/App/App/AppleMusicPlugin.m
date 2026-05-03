#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// AppleMusicPlugin — Capacitor bridge.
//
// Reduced 2026-05-04 to TTS-only after the MusicKit refactor was
// reverted (Swift compile errors with ApplicationMusicPlayer.Queue
// initialisers). The plugin still hosts native TTS playback because
// AVAudioPlayer-in-our-app-session sounds noticeably better than
// HTML5 Audio in WKWebView. Music control was removed entirely;
// Calypso has no music tools right now.

CAP_PLUGIN(AppleMusicPlugin, "AppleMusic",
    CAP_PLUGIN_METHOD(playTtsAudio, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(cancelTtsAudio, CAPPluginReturnPromise);
)
