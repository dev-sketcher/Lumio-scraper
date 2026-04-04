# Publishing

This guide describes the recommended way to version, package, and release plugins
from this source so they work cleanly in Lumio.

## Repository model

Each plugin should live in its own folder under:

```text
plugins/<slug>/
```

Each plugin should have:

- `plugin.json`
- `README.md`
- `CHANGELOG.md`

Optional when the plugin is ready for external runtime loading:

- `dist/runtime.js`

And each published plugin should also have an entry in the root `marketplace.json`.

## Release flow

Recommended flow:

1. update plugin files
2. update the version in `plugins/<slug>/plugin.json`
3. update the matching version in `marketplace.json`
4. update `plugins/<slug>/CHANGELOG.md`
5. build and publish `dist/runtime.js` if this release includes executable runtime
6. commit and push
7. create a GitHub release if you want ZIP-based distribution

## Versioning

Keep these in sync for every published plugin release:

- `plugins/<slug>/plugin.json`
- the plugin entry in root `marketplace.json`
- `plugins/<slug>/CHANGELOG.md`

If the repo exposes mismatched versions, Lumio may still discover the plugin, but
update information becomes harder to understand.

## Recommended ZIP layout

For the cleanest Lumio import, package the repo like this:

```text
marketplace.json
plugins/
  streams-scraper/
    plugin.json
    README.md
    CHANGELOG.md
    dist/
      runtime.js
```

Lumio can also read ZIPs that only contain plugin folders with `plugin.json`, but
including the root `marketplace.json` gives a better import path.

## Single-plugin ZIPs

If you only want to distribute one plugin, this layout is also acceptable:

```text
plugins/
  streams-scraper/
    plugin.json
    README.md
    CHANGELOG.md
    dist/
      runtime.js
```

This is useful for:

- direct sharing
- quick testing
- release assets focused on a single plugin

The full-source ZIP is still preferred whenever possible.

## GitHub releases

If you publish GitHub releases, Lumio can use them as a fallback source when the
repository itself does not expose a directly readable `marketplace.json`.

Recommended release notes:

- version number
- short summary of changes
- compatibility notes if relevant
- mention of any auth/setup changes

Recommended release assets:

- a ZIP that includes `marketplace.json` and `plugins/`
- or a ZIP that includes at least one valid plugin folder

If you expect users to install from releases often, prefer naming assets clearly,
for example:

- `lumio-scraper-source-v1.2.0.zip`
- `streams-scraper-v1.2.0.zip`

## Testing before release

Before publishing, test at least one of these flows in Lumio:

1. add the GitHub repo as a source
2. import the ZIP manually

Verify:

- the plugin appears in the discovered list
- metadata is readable
- version looks correct
- README/changelog links resolve as expected
- runtime bundle downloads only if the plugin explicitly publishes one

## GitHub source support

Lumio can read this repository in two ways:

- directly from the root `marketplace.json`
- from a release ZIP if needed

That makes this repo usable both as a live source and as a downloadable package.
