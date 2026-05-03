import Foundation
import Capacitor
import MediaPlayer

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
                call.resolve([
                    "status": "playing",
                    "matched_kind": kind,
                    "title": summary.title,
                    "subtitle": summary.subtitle,
                    "track_count": items.count,
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
        let block = {
            let collection = MPMediaItemCollection(items: items)
            let player = MPMusicPlayerController.systemMusicPlayer
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
        let status = MPMediaLibrary.authorizationStatus()
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

        let stats = quickLibraryStats()
        // First few artist + playlist names so the diagnostic is
        // actually useful — "you've got 47 artists, including Pink
        // Floyd, Dire Straits, Jimmy Buffett" beats raw counts.
        let sampleArtists: [String] = (MPMediaQuery.artists().collections ?? [])
            .prefix(5)
            .compactMap { $0.representativeItem?.artist }
        let samplePlaylists: [String] = (MPMediaQuery.playlists().collections ?? [])
            .prefix(5)
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
        DispatchQueue.main.async {
            MPMusicPlayerController.systemMusicPlayer.pause()
            call.resolve(["status": "paused"])
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPMusicPlayerController.systemMusicPlayer.play()
            call.resolve(["status": "playing"])
        }
    }

    @objc func next(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPMusicPlayerController.systemMusicPlayer.skipToNextItem()
            call.resolve(["status": "skipped"])
        }
    }

    @objc func previous(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPMusicPlayerController.systemMusicPlayer.skipToPreviousItem()
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
            let player = MPMusicPlayerController.systemMusicPlayer
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
