# Changelog

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
