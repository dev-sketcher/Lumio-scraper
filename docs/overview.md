# Overview

This repository hosts scraper-oriented plugins for Lumio.

Unlike the official marketplace repository, this source is focused on plugins that
extend Lumio's streaming and scraper capabilities and may be distributed through a
separate plugin source.

## How Lumio reads this repo

Lumio looks for the root `marketplace.json`, then treats each entry as a separate
installable plugin. If a direct manifest is not available, Lumio can also inspect
release ZIPs as a fallback source.

That means this repository can publish one plugin or many plugins over time.

## Current focus

Today the repository contains:

- `streams-scraper`

Over time it can expand with more scraper-adjacent plugins that belong together
under the same source.
