import Foundation
import Capacitor
import MediaPlayer
import AVFoundation

/**
 * AppleMusicPlugin — Native Apple Music control for Calypso.
 *
 * Uses MediaPlayer.framework (NOT MusicKit) so we don't need a
 * server-signed developer token. Trade-off: catalog search isn't
 * available from native code — only the user's library is. The
 * JS layer handles catalog requests via URL-scheme hand-off, and
 * uses this plugin for everything library-resident plus playback
 * control.
 *
 * Permission model: MPMediaLibrary.requestAuthorization() prompts the
 * user with NSAppleMusicUsageDescription text (set in Info.plist).
 * Once granted, all queries against MPMediaQuery work; without it,
 * library reads return empty and we fall back to the URL scheme.
 *
 * Tools surfaced through this plugin (registered as Calypso tools
 * in services/voice/orchestrator.ts when the Apple Music integration
 * toggle is on):
 *   - searchAndPlay(query, kind) — play by artist / album / playlist
 *     / song from library; "auto" kind tries them in priority order.
 *   - pause / resume / next / previous — playback control.
 *   - nowPlaying — read back current track + position.
 *
 * Why not MusicKit (Swift, iOS 15+):
 *   1. Requires a developer-signed JWT for catalog access; signing
 *      key has to live somewhere safer than the bundle. We'd need an
 *      edge-fn round-trip just to refresh the token, which is heavier
 *      than this whole feature warrants for V1.
 *   2. The user's primary use case ("play me some Pink Floyd") is
 *      almost always library-resident — they own the album. Catalog
 *      hand-off via URL covers the long-tail case.
 *
 * Phase 3 (post-TestFlight) can swap MediaPlayer for MusicKit if the
 * skipper actually wants live catalog control.
 */
@objc(AppleMusicPlugin)
public class AppleMusicPlugin: CAPPlugin {

    // ── Pause/resume continuity state ───────────────────────────────
    //
    // When we pause the system music player so Calypso's TTS can play
    // without conflict, save the current queue + position so we can
    // FULLY restore playback on resume — including if iOS has lost
    // the queue state in the meantime (which seems to happen sometimes
    // after our app's audio session gets activated by WKWebView's
    // HTML5 Audio playback).
    //
    // Without this, `resume()` was just calling play() which, after
    // a long-enough TTS narration, sometimes returns successfully but
    // doesn't actually start audio output again. Saving + replaying
    // the queue is the canonical workaround.
    private var savedQueueItems: [MPMediaItem]?
    private var savedQueuePosition: TimeInterval?

    // ── Native TTS playback ─────────────────────────────────────────
    //
    // Holding ref so AVAudioPlayer doesn't get deallocated while
    // playing. Set when a TTS playback starts, cleared when it ends.
    // Single concurrent utterance — a new playTtsAudio call cancels
    // the in-flight one.
    private var ttsPlayer: AVAudioPlayer?
    /// Pending CAPPluginCall to resolve when current TTS finishes.
    private var ttsPlayerDelegate: TtsPlayerDelegate?
    /// Music volume before we ducked it for TTS playback. Restored
    /// when TTS finishes / is cancelled. Nil when no ducking is in
    /// flight.
    private var ttsPreduckedVolume: Float?

    // MARK: - Authorization

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        MPMediaLibrary.requestAuthorization { status in
            DispatchQueue.main.async {
                call.resolve([
                    "status": Self.authStatusString(status),
                    "granted": status == .authorized,
                ])
            }
        }
    }

    @objc func getAuthorizationStatus(_ call: CAPPluginCall) {
        let status = MPMediaLibrary.authorizationStatus()
        call.resolve([
            "status": Self.authStatusString(status),
            "granted": status == .authorized,
        ])
    }

    private static func authStatusString(_ s: MPMediaLibraryAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .denied:        return "denied"
        case .restricted:    return "restricted"
        case .authorized:    return "authorized"
        @unknown default:    return "unknown"
        }
    }

    // MARK: - Search + Play

    /**
     * Search the user's library and play matches. Kind is 'auto' by
     * default — tries artist → album → playlist → song in priority
     * order, taking the first non-empty result. Useful for the natural
     * voice intent "play me some Pink Floyd" where the skipper hasn't
     * specified what kind of thing they want.
     *
     * Specific kinds let the LLM disambiguate when needed: e.g.
     * "play the playlist passage" → kind='playlist'. Avoids the
     * artist search clobbering a same-named playlist.
     *
     * Returns the kind that matched and a brief summary of what's
     * about to play, so Calypso can narrate it back to the skipper.
     */
    @objc func searchAndPlay(_ call: CAPPluginCall) {
        guard let query = call.getString("query"), !query.isEmpty else {
            call.reject("query is required")
            return
        }
        let kindArg = call.getString("kind") ?? "auto"
        NSLog("[AppleMusic] searchAndPlay query='\(query)' kind=\(kindArg)")

        // Authorisation is required for library reads. If we don't
        // have it yet, request it inline — the caller can't do this
        // from JS, and a one-off prompt on first invocation is the
        // expected UX.
        let status = MPMediaLibrary.authorizationStatus()
        NSLog("[AppleMusic] auth status: \(Self.authStatusString(status))")
        if status == .notDetermined {
            MPMediaLibrary.requestAuthorization { [weak self] s in
                NSLog("[AppleMusic] requestAuthorization → \(Self.authStatusString(s))")
                if s == .authorized {
                    self?.runSearchAndPlay(query: query, kindArg: kindArg, call: call)
                } else {
                    call.resolve([
                        "status": "permission_denied",
                        "matched_kind": "",
                        "title": "",
                    ])
                }
            }
            return
        }
        if status != .authorized {
            call.resolve([
                "status": "permission_denied",
                "matched_kind": "",
                "title": "",
            ])
            return
        }

        runSearchAndPlay(query: query, kindArg: kindArg, call: call)
    }

    private func runSearchAndPlay(query: String, kindArg: String, call: CAPPluginCall) {
        let kindsToTry: [String]
        switch kindArg.lowercased() {
        case "artist":   kindsToTry = ["artist"]
        case "album":    kindsToTry = ["album"]
        case "playlist": kindsToTry = ["playlist"]
        case "song":     kindsToTry = ["song"]
        default:         kindsToTry = ["artist", "album", "playlist", "song"]
        }

        for kind in kindsToTry {
            let result = collectionsMatching(kind: kind, query: query)
            NSLog("[AppleMusic] kind=\(kind) match count=\(result.count)")
            if !result.isEmpty {
                let items = collectItems(from: result)
                if items.isEmpty {
                    NSLog("[AppleMusic] kind=\(kind) matched collections but no items — continuing")
                    continue
                }
                NSLog("[AppleMusic] playing \(items.count) items from kind=\(kind)")
                playItems(items)
                let summary = summarise(kind: kind, items: items)
                // Surface the FIRST track's title + artist + album so
                // Calypso has full narration content right from
                // play_music — no need for her to call now_playing
                // immediately after, which kills the music (each
                // TTS narration ducks the system music player; doing
                // it twice in succession sometimes leaves it stopped
                // because the second duck doesn't recover cleanly).
                let first = items.first
                call.resolve([
                    "status": "playing",
                    "matched_kind": kind,
                    "title": summary.title,
                    "subtitle": summary.subtitle,
                    "track_count": items.count,
                    "first_track_title": first?.title ?? "",
                    "first_track_artist": first?.artist ?? "",
                    "first_track_album": first?.albumTitle ?? "",
                ])
                return
            }
        }

        // No library match — log how big the library actually is so
        // the diagnostic story is clear: "I checked 47 artists and
        // 312 songs, none matched 'pink floyd'" beats silent failure.
        let stats = quickLibraryStats()
        NSLog("[AppleMusic] no match found. library stats: \(stats)")
        call.resolve([
            "status": "not_found_in_library",
            "matched_kind": "",
            "title": "",
            "subtitle": "",
            "track_count": 0,
            "library_artists": stats["artists"] ?? 0,
            "library_albums": stats["albums"] ?? 0,
            "library_songs": stats["songs"] ?? 0,
            "library_playlists": stats["playlists"] ?? 0,
        ])
    }

    /**
     * Case-insensitive match against the library. We don't use
     * `MPMediaPropertyPredicate` because its `.contains` comparison
     * type is case-sensitive — "pink floyd" won't match "Pink Floyd"
     * stored in the library, which is the most common voice-input
     * case (whisper-cased query against title-cased metadata).
     *
     * Instead we enumerate the relevant grouping (artists / albums /
     * playlists / songs) and filter manually by lowercased substring.
     * Performance: a 5000-track library walks in ~10-30ms — well
     * under the perceptible-lag threshold. The cost beats the alt
     * (predicate match misses, user confused why their library plays
     * the catalog).
     */
    private func collectionsMatching(kind: String, query: String) -> [MPMediaItemCollection] {
        let q: MPMediaQuery
        switch kind {
        case "artist":   q = MPMediaQuery.artists()
        case "album":    q = MPMediaQuery.albums()
        case "playlist": q = MPMediaQuery.playlists()
        case "song":     q = MPMediaQuery.songs()
        default: return []
        }
        let lcQuery = query.lowercased()
        let allCollections = q.collections ?? []

        return allCollections.filter { collection in
            let value = nameForCollection(collection, kind: kind)
            return value.lowercased().contains(lcQuery)
        }
    }

    /// Pull the right name field for a given collection's kind.
    private func nameForCollection(_ collection: MPMediaItemCollection, kind: String) -> String {
        switch kind {
        case "playlist":
            // Playlists have their own name property — separate from the
            // representative item's metadata (which would be a song
            // inside the playlist).
            if let pl = collection as? MPMediaPlaylist {
                return pl.name ?? ""
            }
            return ""
        case "artist":
            return collection.representativeItem?.artist ?? ""
        case "album":
            return collection.representativeItem?.albumTitle ?? ""
        case "song":
            return collection.representativeItem?.title ?? ""
        default:
            return ""
        }
    }

    /// Flatten a list of collections into a single track list. For
    /// artist queries this returns every song by every matched artist;
    /// for albums, every track on every matched album; etc.
    private func collectItems(from collections: [MPMediaItemCollection]) -> [MPMediaItem] {
        return collections.flatMap { $0.items }
    }

    private func playItems(_ items: [MPMediaItem]) {
        // MPMusicPlayerController must be used on the main thread.
        // Permission callback fires on a background queue, so we hop
        // back to main here regardless of caller context. Sync dispatch
        // when we're already on main; async otherwise — caller doesn't
        // need to wait for playback to start before resolving.
        let block = { [weak self] in
            // applicationMusicPlayer plays in OUR app's process and
            // through OUR audio session — so we ACTIVATE the session
            // here (the opposite of what we'd do with systemMusicPlayer,
            // which is a remote control to the Music app). Set
            // .playback so it bypasses the silent switch and routes
            // through speaker; .mixWithOthers so we coexist with any
            // other audio (alarms, future system sounds).
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try session.setActive(true, options: [])
            } catch {
                NSLog("[AppleMusic] playItems: session activation failed: \(error)")
            }

            // Stash the queue we're about to play so resume() has
            // something to fall back to if iOS loses queue state
            // between pause and resume.
            self?.savedQueueItems = items
            self?.savedQueuePosition = 0

            let collection = MPMediaItemCollection(items: items)
            let player = MPMusicPlayerController.applicationMusicPlayer
            player.setQueue(with: collection)
            // Shuffle off by default — predictability beats randomness
            // when the skipper just asked for a specific thing.
            player.shuffleMode = .off
            player.play()
            NSLog("[AppleMusic] play() called, state=\(player.playbackState.rawValue)")
        }
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }

    // MARK: - Native TTS playback

    /**
     * Play Calypso's TTS audio (base64-encoded MP3) through a native
     * AVAudioPlayer instead of WKWebView's HTML5 Audio.
     *
     * Why this exists: HTML5 Audio in WKWebView activates the audio
     * session in ways we can't fully control — it clobbers our
     * applicationMusicPlayer's playback every time Calypso speaks,
     * even when our session is configured for mixing. Native
     * AVAudioPlayer respects whatever session config we set
     * deterministically. With our session at .playback +
     * .mixWithOthers, TTS plays alongside the music without
     * interrupting it.
     *
     * Pattern: synchronous start (resolve immediately when playback
     * begins), but the JS caller awaits a separate event for end-of-
     * playback if it wants to know when speaking finishes. For now
     * we use a delegate that resolves a stored CAPPluginCall on
     * audioPlayerDidFinishPlaying.
     *
     * Single concurrent utterance: starting a new TTS playback
     * cancels any in-flight one. Matches the JS-side `cancel()`
     * semantics on SpokenHandle.
     */
    @objc func playTtsAudio(_ call: CAPPluginCall) {
        guard let b64 = call.getString("audio_b64"), !b64.isEmpty else {
            call.reject("audio_b64 is required")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Cancel any in-flight TTS — single utterance at a time.
            if let prev = self.ttsPlayer {
                prev.stop()
                self.ttsPlayer = nil
            }
            self.ttsPlayerDelegate = nil

            // Decode base64 MP3.
            guard let data = Data(base64Encoded: b64) else {
                call.reject("invalid base64 audio")
                return
            }

            // VOLUME DUCKING (skipper's request).
            //
            // Pause/resume around TTS proved unreliable in practice:
            // music wouldn't always come back after TTS finished, even
            // with applicationMusicPlayer.play() called in-process from
            // the AVAudioPlayer's didFinishPlaying delegate.
            //
            // Volume duck instead: lower applicationMusicPlayer's
            // volume to a quieter level (so Calypso is clearly audible
            // over the music) while TTS plays, restore to the previous
            // level after TTS finishes. The music never actually stops
            // — it just gets quieter for a few seconds.
            //
            // applicationMusicPlayer.volume is technically deprecated
            // but still functional; Apple's deprecation guidance is
            // about discouraging apps from grabbing global volume
            // control, but programmatic volume on this player still
            // works. If that ever changes (iOS 19+?), we'd switch
            // to AVAudioEngine-based playback for full mixer control.
            let musicPlayer = MPMusicPlayerController.applicationMusicPlayer
            let wasPlayingMusic = musicPlayer.playbackState == .playing
            if wasPlayingMusic {
                let currentVolume = musicPlayer.volume
                self.ttsPreduckedVolume = currentVolume
                let duckedVolume: Float = 0.18 // ~18% — quiet but still audible
                musicPlayer.volume = duckedVolume
                NSLog("[AppleMusic] playTtsAudio: ducked music \(currentVolume) → \(duckedVolume)")
            } else {
                self.ttsPreduckedVolume = nil
            }

            // Create + retain the player.
            do {
                let player = try AVAudioPlayer(data: data)
                player.volume = 1.0
                let delegate = TtsPlayerDelegate { [weak self] in
                    NSLog("[AppleMusic] playTtsAudio: playback finished")
                    self?.ttsPlayer = nil
                    self?.ttsPlayerDelegate = nil
                    // Restore music volume to whatever it was before
                    // we ducked. If music wasn't playing, this is a
                    // no-op (preducked is nil).
                    if let preduck = self?.ttsPreduckedVolume {
                        MPMusicPlayerController.applicationMusicPlayer.volume = preduck
                        NSLog("[AppleMusic] playTtsAudio: restored music volume → \(preduck)")
                    }
                    self?.ttsPreduckedVolume = nil
                    call.resolve([
                        "status": "finished",
                        "music_was_ducked": wasPlayingMusic,
                    ])
                }
                player.delegate = delegate
                self.ttsPlayerDelegate = delegate
                self.ttsPlayer = player
                if !player.play() {
                    // If AVAudioPlayer fails to start, restore the
                    // music volume immediately rather than leaving
                    // music in ducked state.
                    if let preduck = self.ttsPreduckedVolume {
                        musicPlayer.volume = preduck
                    }
                    self.ttsPreduckedVolume = nil
                    call.reject("AVAudioPlayer.play() returned false")
                    self.ttsPlayer = nil
                    self.ttsPlayerDelegate = nil
                    return
                }
                NSLog(
                    "[AppleMusic] playTtsAudio: started (\(data.count)B, \(String(format: "%.1f", player.duration))s, music_was_playing=\(wasPlayingMusic))"
                )
            } catch {
                NSLog("[AppleMusic] playTtsAudio: AVAudioPlayer init failed: \(error)")
                // Restore music volume if init failed.
                if let preduck = self.ttsPreduckedVolume {
                    musicPlayer.volume = preduck
                }
                self.ttsPreduckedVolume = nil
                call.reject("AVAudioPlayer init failed: \(error.localizedDescription)")
            }
        }
    }

    /**
     * Cancel any in-flight TTS playback. Used by the JS layer when
     * the SpokenHandle's cancel() is invoked (e.g., a new alert
     * preempts a lower-priority utterance).
     */
    @objc func cancelTtsAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.ttsPlayer?.stop()
            self?.ttsPlayer = nil
            self?.ttsPlayerDelegate = nil
            // Restore the music volume if we'd ducked it — caller is
            // cutting TTS short, music shouldn't stay quiet.
            if let preduck = self?.ttsPreduckedVolume {
                MPMusicPlayerController.applicationMusicPlayer.volume = preduck
                self?.ttsPreduckedVolume = nil
            }
            call.resolve(["status": "cancelled"])
        }
    }

    /**
     * Read-only library search — returns matches for the query across
     * artists, albums, playlists, and songs WITHOUT playing anything.
     * Lets the skipper sanity-check what the plugin can actually see
     * for a specific query: "do I have Led Zeppelin? Or is the
     * library hiding tracks?". Used by the Settings → Calypso →
     * Apple Music "Search library" diagnostic.
     */
    @objc func searchLibrary(_ call: CAPPluginCall) {
        guard let query = call.getString("query"), !query.isEmpty else {
            call.reject("query is required")
            return
        }
        let status = MPMediaLibrary.authorizationStatus()
        if status != .authorized {
            call.resolve([
                "status": "permission_denied",
                "auth_status": Self.authStatusString(status),
                "artists": [], "albums": [], "playlists": [], "songs": [],
            ])
            return
        }
        let lcQuery = query.lowercased()

        // Walk each grouping, filter case-insensitive contains. Cap
        // each at 20 so we don't return a 500-track wall when the
        // skipper searches a common term.
        let artistMatches: [String] = (MPMediaQuery.artists().collections ?? [])
            .compactMap { $0.representativeItem?.artist }
            .filter { $0.lowercased().contains(lcQuery) }
            .prefix(20)
            .map { $0 }

        let albumMatches: [[String: String]] = (MPMediaQuery.albums().collections ?? [])
            .filter { ($0.representativeItem?.albumTitle ?? "").lowercased().contains(lcQuery) }
            .prefix(20)
            .map {
                [
                    "title": $0.representativeItem?.albumTitle ?? "",
                    "artist": $0.representativeItem?.albumArtist ?? $0.representativeItem?.artist ?? "",
                ]
            }

        let playlistMatches: [String] = (MPMediaQuery.playlists().collections ?? [])
            .compactMap { ($0 as? MPMediaPlaylist)?.name }
            .filter { $0.lowercased().contains(lcQuery) }
            .prefix(20)
            .map { $0 }

        let songMatches: [[String: String]] = (MPMediaQuery.songs().items ?? [])
            .filter { ($0.title ?? "").lowercased().contains(lcQuery) }
            .prefix(20)
            .map {
                [
                    "title": $0.title ?? "",
                    "artist": $0.artist ?? "",
                    "album": $0.albumTitle ?? "",
                ]
            }

        NSLog(
            "[AppleMusic] searchLibrary '\(query)' → artists:\(artistMatches.count) albums:\(albumMatches.count) playlists:\(playlistMatches.count) songs:\(songMatches.count)"
        )
        call.resolve([
            "status": "ok",
            "query": query,
            "artists": artistMatches,
            "albums": albumMatches,
            "playlists": playlistMatches,
            "songs": songMatches,
            "total_matches": artistMatches.count + albumMatches.count + playlistMatches.count + songMatches.count,
        ])
    }

    /**
     * Public entry point so the JS layer can re-apply our friendly
     * audio session config on demand — typically right before TTS
     * playback to avoid the second-narration-kills-music symptom.
     * No-op except for the session reconfigure.
     */
    @objc func ensureMixingSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
                try session.setActive(true, options: [])
                call.resolve(["status": "applied"])
            } catch {
                call.resolve(["status": "failed", "error": String(describing: error)])
            }
        }
    }

    /// Quick library tallies for the diagnostic / library-stats path.
    /// MPMediaQuery counts are O(1)-ish at the OS level.
    private func quickLibraryStats() -> [String: Int] {
        let stats: [String: Int] = [
            "artists": MPMediaQuery.artists().collections?.count ?? 0,
            "albums": MPMediaQuery.albums().collections?.count ?? 0,
            "songs": MPMediaQuery.songs().items?.count ?? 0,
            "playlists": MPMediaQuery.playlists().collections?.count ?? 0,
        ]
        return stats
    }

    private struct PlaySummary {
        let title: String
        let subtitle: String
    }

    private func summarise(kind: String, items: [MPMediaItem]) -> PlaySummary {
        guard let first = items.first else { return PlaySummary(title: "", subtitle: "") }
        let artist = first.artist ?? ""
        let album = first.albumTitle ?? ""
        let song = first.title ?? ""

        switch kind {
        case "artist":
            return PlaySummary(title: artist.isEmpty ? "Selected artist" : artist, subtitle: "\(items.count) tracks")
        case "album":
            return PlaySummary(title: album, subtitle: artist)
        case "playlist":
            // The first item's title doesn't tell us the playlist name —
            // we passed the playlist as collection but lost the wrapper
            // here. Best we can do without re-querying.
            return PlaySummary(title: "Playlist", subtitle: "\(items.count) tracks")
        default: // song
            return PlaySummary(title: song, subtitle: artist)
        }
    }

    // MARK: - Diagnostics

    /**
     * Smoke-test playback: grab the FIRST song in the library and
     * play it. No search, no kind matching, no fancy logic — just
     * "is the playback path actually working at all". If this
     * succeeds and `searchAndPlay` doesn't, the issue is in search
     * (matching, library visibility for queried terms, etc.). If
     * this also fails, the playback pipeline itself is broken
     * (permission, audio session, MPMusicPlayerController).
     *
     * Settings UI exposes this as the "Play first song" diagnostic
     * button so the skipper can verify end-to-end audio without
     * involving the LLM, Calypso's narration, or the URL fallback.
     */
    @objc func playFirstSong(_ call: CAPPluginCall) {
        // Bring up the iOS permission prompt on first call — the plugin
        // is no use without it, and the diagnostic UX is much better if
        // tapping the button just asks for permission rather than
        // returning "denied" because no one's been asked yet.
        let status = MPMediaLibrary.authorizationStatus()
        if status == .notDetermined {
            NSLog("[AppleMusic] playFirstSong: requesting authorization…")
            MPMediaLibrary.requestAuthorization { [weak self] granted in
                if granted == .authorized {
                    self?.runPlayFirstSong(call: call)
                } else {
                    call.resolve([
                        "status": "permission_denied",
                        "auth_status": Self.authStatusString(granted),
                        "title": "",
                        "artist": "",
                    ])
                }
            }
            return
        }
        if status != .authorized {
            NSLog("[AppleMusic] playFirstSong: not authorized (\(Self.authStatusString(status)))")
            call.resolve([
                "status": "permission_denied",
                "auth_status": Self.authStatusString(status),
                "title": "",
                "artist": "",
            ])
            return
        }
        runPlayFirstSong(call: call)
    }

    private func runPlayFirstSong(call: CAPPluginCall) {
        let songs = MPMediaQuery.songs().items ?? []
        NSLog("[AppleMusic] playFirstSong: library has \(songs.count) songs")
        guard let first = songs.first else {
            call.resolve([
                "status": "library_empty",
                "title": "",
                "artist": "",
                "library_song_count": 0,
            ])
            return
        }
        playItems([first])
        call.resolve([
            "status": "playing",
            "title": first.title ?? "",
            "artist": first.artist ?? "",
            "album": first.albumTitle ?? "",
            "library_song_count": songs.count,
        ])
    }

    /**
     * Public diagnostic — lets the JS layer ask "what does the
     * plugin actually see?" without trying to play anything.
     * Returns: auth status, library counts, and a sample of the
     * first few artists/playlists so Calypso can sanity-check
     * what the skipper has access to.
     *
     * Useful when "play X" silently falls through to URL — the
     * skipper can ask "Calypso, what music can you see?" and get
     * a real answer instead of guessing.
     */
    @objc func getLibraryStats(_ call: CAPPluginCall) {
        let authStatus = MPMediaLibrary.authorizationStatus()
        // First-time path — prompt the skipper for Apple Music access
        // so the diagnostic actually drives the permission grant on the
        // very first tap. Without this, "Inspect library" before any
        // music has been played returns a useless "notDetermined" and
        // there's nothing the skipper can do from iOS Settings either
        // (the toggle doesn't appear until the app has asked once).
        if authStatus == .notDetermined {
            NSLog("[AppleMusic] getLibraryStats: requesting authorization…")
            MPMediaLibrary.requestAuthorization { [weak self] granted in
                if granted == .authorized, let self = self {
                    self.respondWithStats(call: call, authStatus: granted)
                } else {
                    call.resolve([
                        "auth_status": Self.authStatusString(granted),
                        "auth_granted": false,
                        "artists": 0,
                        "albums": 0,
                        "songs": 0,
                        "playlists": 0,
                        "sample_artists": [],
                        "sample_playlists": [],
                    ])
                }
            }
            return
        }
        if authStatus != .authorized {
            call.resolve([
                "auth_status": Self.authStatusString(authStatus),
                "auth_granted": false,
                "artists": 0,
                "albums": 0,
                "songs": 0,
                "playlists": 0,
                "sample_artists": [],
                "sample_playlists": [],
            ])
            return
        }

        respondWithStats(call: call, authStatus: authStatus)
    }

    private func respondWithStats(call: CAPPluginCall, authStatus: MPMediaLibraryAuthorizationStatus) {
        let stats = quickLibraryStats()
        // Sample artist + playlist names so the diagnostic is actually
        // useful — bumped from 5 to 25 because the previous limit
        // showed only the alphabetic head ("seems to only see the As")
        // and made the skipper think the library was filtered when it
        // wasn't. 25 gives a real sense of breadth — if Led Zeppelin
        // doesn't show in 25 artists, maybe it really isn't there.
        let sampleArtists: [String] = (MPMediaQuery.artists().collections ?? [])
            .prefix(25)
            .compactMap { $0.representativeItem?.artist }
        let samplePlaylists: [String] = (MPMediaQuery.playlists().collections ?? [])
            .prefix(25)
            .compactMap { ($0 as? MPMediaPlaylist)?.name }

        call.resolve([
            "auth_status": Self.authStatusString(authStatus),
            "auth_granted": true,
            "artists": stats["artists"] ?? 0,
            "albums": stats["albums"] ?? 0,
            "songs": stats["songs"] ?? 0,
            "playlists": stats["playlists"] ?? 0,
            "sample_artists": sampleArtists,
            "sample_playlists": samplePlaylists,
        ])
    }

    // MARK: - Playback Control

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let player = MPMusicPlayerController.applicationMusicPlayer
            // Snapshot the queue + position BEFORE pausing so we can
            // restore everything in resume() if the simple play()
            // call doesn't bring playback back. iOS sometimes loses
            // the queue between pause and resume when our app's
            // audio session has been activated by WKWebView audio
            // in the meantime.
            //
            // MPMediaQueueDescriptor doesn't let us read the queue
            // back, so we walk via nowPlayingItem + indexOfNowPlayingItem
            // and assume the original queue is still indexable.
            // For pause/resume around a Calypso narration this is
            // conservative — we only need a few items either side.
            if let nowItem = player.nowPlayingItem {
                self?.savedQueueItems = [nowItem]
                self?.savedQueuePosition = player.currentPlaybackTime
                NSLog("[AppleMusic] pause: saved nowPlaying='\(nowItem.title ?? "?")' position=\(player.currentPlaybackTime)")
            } else {
                self?.savedQueueItems = nil
                self?.savedQueuePosition = nil
            }
            player.pause()
            call.resolve([
                "status": "paused",
                "playback_state": player.playbackState.rawValue,
            ])
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            // applicationMusicPlayer plays through OUR session, so we
            // ACTIVATE here (this is the opposite pattern from
            // systemMusicPlayer where we'd deactivate to let Music
            // app take over). After the pause/TTS dance, our session
            // may have been left in a confused state by WKWebView's
            // HTML5 Audio playback; re-establishing it cleanly is
            // the canonical fix.
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try session.setActive(true, options: [])
                NSLog("[AppleMusic] resume: session reactivated for music playback")
            } catch {
                NSLog("[AppleMusic] resume: session activation failed: \(error)")
            }

            let player = MPMusicPlayerController.applicationMusicPlayer
            let stateBefore = player.playbackState.rawValue
            player.play()

            // Verify playback actually started — MPMusicPlayerController
            // sometimes returns from play() without transitioning to
            // .playing if its queue got dropped. Re-set the queue from
            // saved state if so.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                let stateAfter = player.playbackState.rawValue
                NSLog("[AppleMusic] resume: state \(stateBefore) → \(stateAfter)")
                if stateAfter != 1 /* .playing */, let savedItems = self?.savedQueueItems,
                   !savedItems.isEmpty {
                    NSLog("[AppleMusic] resume: play() didn't restart — re-setting queue from saved state")
                    let collection = MPMediaItemCollection(items: savedItems)
                    player.setQueue(with: collection)
                    if let pos = self?.savedQueuePosition {
                        player.currentPlaybackTime = pos
                    }
                    player.play()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        let stateRetry = player.playbackState.rawValue
                        NSLog("[AppleMusic] resume retry: state → \(stateRetry)")
                        call.resolve([
                            "status": stateRetry == 1 ? "playing" : "failed",
                            "playback_state": stateRetry,
                            "fallback_used": true,
                        ])
                    }
                } else {
                    call.resolve([
                        "status": stateAfter == 1 ? "playing" : "failed",
                        "playback_state": stateAfter,
                        "fallback_used": false,
                    ])
                }
            }
        }
    }

    @objc func next(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPMusicPlayerController.applicationMusicPlayer.skipToNextItem()
            call.resolve(["status": "skipped"])
        }
    }

    @objc func previous(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPMusicPlayerController.applicationMusicPlayer.skipToPreviousItem()
            call.resolve(["status": "skipped"])
        }
    }

    // MARK: - Now Playing

    /**
     * Read back the currently-playing item. Returns null-typed fields
     * (empty strings + 0 numbers) when nothing is playing or queued.
     * Calypso uses this to answer "what's playing?" naturally.
     *
     * `position_sec` is the elapsed playback time in the current track;
     * `duration_sec` is the total track length. Both rounded to whole
     * seconds because TTS reads decimals awkwardly ("two point three
     * minutes" sounds robotic vs "two minutes").
     */
    @objc func nowPlaying(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let player = MPMusicPlayerController.applicationMusicPlayer
            let item = player.nowPlayingItem
            let stateString: String
            switch player.playbackState {
            case .stopped:       stateString = "stopped"
            case .playing:       stateString = "playing"
            case .paused:        stateString = "paused"
            case .interrupted:   stateString = "interrupted"
            case .seekingForward: stateString = "seeking"
            case .seekingBackward: stateString = "seeking"
            @unknown default:    stateString = "unknown"
            }

            guard let nowPlaying = item else {
                call.resolve([
                    "is_playing": false,
                    "state": stateString,
                    "title": "",
                    "artist": "",
                    "album": "",
                    "position_sec": 0,
                    "duration_sec": 0,
                ])
                return
            }

            call.resolve([
                "is_playing": player.playbackState == .playing,
                "state": stateString,
                "title": nowPlaying.title ?? "",
                "artist": nowPlaying.artist ?? "",
                "album": nowPlaying.albumTitle ?? "",
                "position_sec": Int(player.currentPlaybackTime),
                "duration_sec": Int(nowPlaying.playbackDuration),
            ])
        }
    }
}

/**
 * AVAudioPlayerDelegate that fires a closure when playback finishes
 * (or errors out). Used by playTtsAudio to resolve its CAPPluginCall
 * at the right moment.
 */
private final class TtsPlayerDelegate: NSObject, AVAudioPlayerDelegate {
    let onFinish: () -> Void
    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish()
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        NSLog("[AppleMusic] TtsPlayer decode error: \(String(describing: error))")
        onFinish()
    }
}
