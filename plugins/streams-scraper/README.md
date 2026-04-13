# Streams Scraper

Streams Scraper is an external plugin that adds scraper-backed streaming sources
to Lumio Media Player.

## What it does

- provides stream options from configured scraper backends
- plugs into Lumio's stream sidebar
- keeps playback resolution inside the plugin layer
- exposes scraper-related settings through its own plugin section

## Built for Lumio

This plugin is packaged to work through Lumio's plugin system and can be installed
from a GitHub source or a compatible ZIP package.

It is distributed from its own repository so it can evolve independently while
still integrating cleanly with Lumio.

This plugin now contains two runtime slices:
- scraper settings UI
- playback capability checks for the main play button
- scraper-provided download action

The more sensitive stream sidebar and playback/provider pipeline still remain in
Lumio core until they can be migrated behind safer stream-provider SDK
contracts without breaking existing settings.

## Install

In Lumio:

1. Open `Settings`
2. Go to `Plugins`
3. Add this repository as a GitHub source or import a ZIP
4. Install `Streams Scraper`
