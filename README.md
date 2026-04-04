# Lumio Scraper Plugins

A third-party plugin source for scraper and streaming plugins that are designed
to work with Lumio Media Player.

This repository is maintained independently and is not an official Lumio
marketplace repository. Lumio can read the root `marketplace.json` here,
discover the published plugins, and present them as installable options inside
the app.

## At a glance

- independent plugin source built for Lumio compatibility
- focused on scraper-oriented and streaming-related plugins
- works with Lumio's GitHub source flow
- works with ZIP import and release assets
- publishes metadata and docs now, with runtime bundles added plugin-by-plugin later
- currently includes `streams-scraper`

## Quick start

### Add this repo as a source in Lumio

1. Open `Settings`
2. Open `Plugins`
3. Add the GitHub source:

```text
https://github.com/dev-sketcher/Lumio-scraper
```

4. Lumio reads `marketplace.json`
5. Install the plugin you want from the discovered list

At the moment this source publishes plugin metadata and install information.
External runtime bundles can be added later per plugin when they are packaged
for source-based loading.

### Or import a ZIP

Lumio can also import:

- a ZIP with a root `marketplace.json`
- or a ZIP with one or more plugin folders that contain `plugin.json`

That makes this repo useful for:

- testing and staging
- manual distribution
- release-based installs
- private sharing between trusted users

## What lives here

- `marketplace.json`
  The source manifest Lumio reads.
- `plugins/<slug>/plugin.json`
  Plugin metadata.
- `plugins/<slug>/README.md`
  Public plugin documentation.
- `plugins/<slug>/CHANGELOG.md`
  Release notes per plugin.
- `plugins/<slug>/dist/runtime.js` (optional)
  Published runtime bundle when a plugin is ready for external runtime loading.
- `docs/`
  Notes for maintainers and developers working on scraper plugins.

## Current plugins

- `streams-scraper`

## Why this repo exists

This repo exists to publish scraper-oriented plugins in a separate source while
still making them easy to install in Lumio.

That means users can:

- add the repo directly as a GitHub source
- install from a release ZIP
- keep scraper plugins separate from other plugin collections

Runtime bundles are intentionally optional, so plugins can be published in a
metadata-first state before their executable runtime is packaged for source installs.

## Compatibility with Lumio

The plugins published here are structured so Lumio can discover them through:

- the root `marketplace.json`
- GitHub source installs
- ZIP imports
- GitHub release ZIP fallback

The goal is to make this repo feel like a clean external plugin source that
plugs into Lumio naturally.

## Releases and ZIP distribution

This repository is designed to work well with GitHub releases and ZIP-based
distribution.

### Recommended release flow

1. Update plugin files and documentation
2. Update the plugin version in:
   - `plugins/<slug>/plugin.json`
   - `marketplace.json`
3. Update `CHANGELOG.md`
4. Commit and push
5. Create a GitHub release
6. Attach a ZIP if you want a clean import package

### Good release assets

If you publish releases, try to include:

- a source ZIP that Lumio can inspect
- up-to-date `README.md`
- up-to-date `CHANGELOG.md`
- a matching version in both `plugin.json` and `marketplace.json`

That gives users two install paths:

- add the repo as a GitHub source
- or import the ZIP directly

### ZIP recommendations

Best case:

- include the root `marketplace.json`
- include plugin folders under `plugins/`

Example:

```text
Lumio-scraper.zip
  marketplace.json
  plugins/
    streams-scraper/
      plugin.json
      README.md
      CHANGELOG.md
      dist/
        runtime.js
```

That gives Lumio the cleanest import path.

### Release assets

If a repository does not expose a root `marketplace.json` directly, Lumio can also
try to inspect the latest GitHub release ZIP automatically.

That means a published release can act as a fallback install source.

## Recommended ZIP examples

### Full source ZIP

```text
Lumio-scraper.zip
  marketplace.json
  plugins/
    streams-scraper/
      plugin.json
      README.md
      CHANGELOG.md
```

### Single-plugin ZIP

```text
streams-scraper.zip
  plugins/
    streams-scraper/
      plugin.json
      README.md
      CHANGELOG.md
      dist/
        runtime.js
```

Both can work, but the full source ZIP gives Lumio more context and is the
recommended format.

## Repo structure

```text
Lumio-scraper/
  marketplace.json
  docs/
    overview.md
    publishing.md
  plugins/
    streams-scraper/
      plugin.json
      README.md
      CHANGELOG.md
```

## In Lumio

Users can add this repository in the Plugins settings by:

- pasting the GitHub repo URL as a source
- or importing a ZIP built from this repository

Once the source is added, Lumio reads the manifest and shows any published plugins
from this repo as installable options.

## Status

This is an external plugin source intended for Lumio Media Player users who want
scraper-focused plugins from a separate repository.

## For maintainers

The documentation in `docs/` explains how this source is structured and how to
publish updates over time:

- [Overview](./docs/overview.md)
- [Publishing](./docs/publishing.md)
