# Changelog

## 1.0.35

- The embedded player now carries the app's casting support: the cast menu
  (Chromecast/DLNA device list plus the new AirPlay flow) is available when
  playing through the plugin, instead of the pre-casting player this runtime
  was last built against.
- AirPlay rides WebKit's video target picker with an H.264 ≤1080p hardware
  transcode for MKV/HEVC sources, burned-in active subtitles, and automatic
  mpv handover/handback. Requires app 0.2.21+ for the preparation endpoint —
  on older apps the AirPlay row shows a cast error and the rest of the menu
  works as before.

## 1.0.34

- Remembered-stream matching survives re-searches: scrapers return url-only results (no infoHash field), so the torrent hash is now pulled out of the URL, with the release name as a final fallback. Previously an exact URL match was required, which a regenerated token or host would break — silently dropping back to the ranked list.
- New `remembered stream lookup` telemetry states whether a saved stream existed and where it landed in the candidate list, so a resume picking the "wrong" source is diagnosable instead of guesswork.

## 1.0.33

- Resume reuses the stream that actually played. The source is remembered per title/episode (explicit sidebar picks too) and tried first on the next play, so "Fortsätt" starts on the same source and skips re-racing the ranked list — with the normal candidate order still available as fallback if that source has since disappeared.

## 1.0.32

- Reports the settled stream count to the host (`onStreamsResult`) so the app can hide Play/Download on titles where the search found nothing, instead of offering a click that must fail.

## 1.0.31

- Plugin UI now follows the app's language picker (rebuilt against the host's fixed i18n module — plugin bundles used to be stuck on the English default because the host's language context never reached their bundled copy).

## 1.0.30

- TorrentsDB retired as a scraper. Its playback URLs are rate-limited server-side (HTTP 429 "Too many requests") even for streams it labels as cached, so every play attempt through it failed. The preset is no longer offered in settings, and already-configured TorrentsDB scrapers are dropped automatically on load — no user action needed.

## 1.0.29

- Per-candidate start window raised 12 s → 20 s. Torrentio `/resolve` URLs routinely need 10-15 s before first byte and play fine manually — the 12 s window abandoned the working first stream moments before it started, then burned 12 s on the next slow candidate (~30 s to playback). Real failures (e.g. torrentsdb's HTTP 429 rate-limited playback URLs, whose CACHED badge is label-only) still advance in under a second via the player's load-failed signal; only silently hanging sources pay the full window.

## 1.0.28

- Autoplay candidates now follow the sidebar's own display order, top-down, up to 5 streams — pressing play behaves like clicking the visible list until one plays. Previously the candidate builder resolved to the HOST app's copy (build-time `@/lib` aliasing), which reordered by cached-flag/language and capped at 3; on real lookups that picked three dud url-only sources and skipped the very stream a manual click on the first row plays. The max-size setting is now a preference (within-cap streams first) instead of a veto.
- The "Startar avsnitt/film…" splash is dismissed when every candidate fails (it used to stay up forever once the close-path stopped running in 1.0.27) — the stream sidebar opens instead.
- Play-request tokens are now consumed across remounts (module-level guard) and cleared on manual stream clicks and player close, so a finished/failed play request can no longer replay itself and throw up a ghost loading screen after the user moved on.
- Telemetry: `autoplay resolve start` now logs the consuming token; new `pending play request consumed` event.

## 1.0.27

- Fixed the actual reason play buttons bounced to home/detail even though 1.0.26's retry loop was in place: the player's dead-stream escape hatch (mpv end-file error before first frame, typically its ~10 s network timeout on a dead mediafusion URL) closed the whole playback session mid-loop, cancelling the attempt before candidates 2+ were tried. The player now reports the failure to the autoplay loop (which keeps the modal open, swaps in the next stream immediately instead of waiting out the 12 s window) and only closes when no loop is driving it.
- Autoplay now tries up to 5 streams top-down (was 3), matching manually clicking through the sidebar until one plays.

## 1.0.26

- Play buttons (Spela/hero/detail/continue) now play like a manual sidebar click that works: they try each stream in the player and, if playback does not actually start (verified via the player's first-frame event), automatically advance to the next stream — instead of committing to the first (often dead) source. Dead/unplayable sources are skipped without exiting to the home/detail view. Replaces the unreliable URL probe.

## 1.0.25

- Autoplay now verifies a direct stream URL is actually alive (probe) before committing to it. Previously "Spela" opened a player on the first (often dead) mediafusion/torbox URL, stalled, and never tried the next working stream — so it bounced back with no playback even though a later stream in the list plays fine. It now skips dead URLs and plays the first that works, matching a manual click on a working stream.

## 1.0.24

- Diagnostics: autoplay now logs candidate counts, whether each candidate has a direct URL vs infoHash, the resolve outcome, and the running plugin version — so a failed "Spela" pinpoints exactly where it breaks.

## 1.0.23

- Autoplay ("Spela"/hero/detail/continue) now selects the playable file exactly like the manual sidebar PLAY: when no filename matches the episode it falls back to the torrent's video file instead of skipping the source. This is why "Spela" failed on the very streams the sidebar plays fine. Play now uses the sidebar's stream list and plays regardless of whether torrentio (or any single scraper) is down.

## 1.0.22

- Autoplay now waits for a source that is still caching on the debrid (status 'downloading') instead of giving up on it, so "Spela" plays sources that are seconds from ready rather than bouncing back. Combined with 1.0.21's delegation, a play button plays whenever any sidebar stream is (or becomes) playable.

## 1.0.21

- Autoplay ("Spela" and all play buttons) now plays a stream whenever one exists in the sidebar. Previously it only started sources already cached on your debrid and gave up (bouncing you out) when a scraper like torrentio was down or a source wasn't pre-cached. It now delegates to the same add-and-wait flow the manual sidebar PLAY uses, independent of which scraper is up.

## 1.0.20

- Playback no longer drops you out of the detail view (to the home page) when a source fails to resolve: an empty player session is never opened — the stream sidebar stays open so you can pick a source.
- Episode file selection falls back to the single video file when a torrent's filename lacks a standard SxxExx tag (single-episode releases no longer bounce with no playback).

## 1.0.15

- Stream search now retries once after 1.5 s when the first attempt returns zero streams. Real-Debrid / scraper caches occasionally return empty mid-refresh; a single retry usually picks up the populated result without making the user navigate back+forward.
- Cleaned up outro-debug logging.

## 1.0.14

- Time-remaining next-episode popup now appears even when stream preload finds zero candidates. `pendingCardInfo` is set up front (after episode metadata is resolved) so the card renders regardless of stream resolution outcome; the "Play now" button stays disabled until streams are ready, with a manual fallback via `allowManualPlayWhenNotReady`.

## 1.0.13

- Wires IntroDB outro detection into the next-episode card so the popup appears at the outro mark and force-overrides the auto-play-next-episode setting (the setting now only gates the 5.2 s autoplay timer, not whether the card shows).
- Adds `prepareNextEpisodeCardInfo` so the card can render with metadata even before stream resolution finishes.
- Dismissing the next-episode card now cancels the pending autoplay timer.

## 1.0.11

- Fixes mobile/LAN details download button to render as true icon-only control (no lingering "Ladda ner" text).
- Aligns mobile header action circles (download, close, menu) for consistent sizing and spacing.

## 1.0.10

- Aligns with hard cutover to neutral stream-provider API routes (no /api/plugins/streams-scraper aliases).
- Syncs runtime with latest in-app stream-provider runtime implementation.

## 1.0.9

- Moves the runtime to a self-contained plugin implementation instead of relying on Moviefinder's internal `lib/plugins/streams-scraper/*` imports.
- Adds instant-play and stream-availability provider registrations in the external runtime.
- Updates desktop Real-Debrid API fallback to SDK-safe desktop command execution for external bundling.

## 1.0.8

- Publishes a freshly minified runtime bundle for lower plugin-cache footprint.
- Keeps full stream-provider/sidebar/playback contract behavior from 1.0.7.

## 1.0.7

- Restores full stream-provider registration in external runtime (same sidebar contract and play flow as baseline).
- Reuses the established Lumio stream sidebar/settings/playback components to avoid UI and behavior regressions.

## 1.0.6

- Rollback release: restores stable pre-separation baseline behavior.
- Keeps update path above 1.0.5 so clients can upgrade cleanly.

## 1.0.0

- Initial scraper plugin source metadata
- Added plugin documentation and marketplace entry
