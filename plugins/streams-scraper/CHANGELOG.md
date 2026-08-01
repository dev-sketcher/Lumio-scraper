# Changelog

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
