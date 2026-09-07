# Changelog

Work log for this fork of [yaroshevych/doomscroll](https://github.com/yaroshevych/doomscroll),
rebranded as **Bloomscroll**.

Upstream releases (0.1.0 – 0.1.5) are recorded in the git history and
`versions.json`; this file starts from the fork.

---

## Unreleased

Forked from upstream `91aad23` ("Release 0.1.5").

### Fixed

- **Plugin failed to load on iOS** with "Failed to load bloomscroll-dev".

  `src/settings.ts` declared `class FolderSuggest extends AbstractInputSuggest`
  at module top level. `AbstractInputSuggest` is not exported by Obsidian's
  mobile builds, so on iOS that line evaluated `class extends undefined` and
  threw a `TypeError` the moment the plugin loaded. Because `manifest.json` sets
  `isDesktopOnly: false`, iOS attempted the load and failed. Desktop was
  unaffected — the API exists there.

  The subclass is now built lazily inside `getFolderSuggestCtor()`, called only
  when the settings tab renders, and guarded by a `typeof Base !== 'function'`
  check. `AbstractInputSuggest` is no longer referenced at module scope.

  *Trade-off:* on mobile the "Add excluded folder" field loses its autocomplete
  dropdown — the path is typed manually. Everything else, including the feed,
  works normally. Desktop behaviour is unchanged.

### Changed

- **Renamed every "Doomscroll" mention to "Bloomscroll"** across source, styles,
  README, and package metadata — class names (`BloomscrollPlugin`,
  `BloomscrollView`, `BloomscrollSettingTab`), all `.bloomscroll-*` CSS classes,
  the npm package name, and user-facing strings.

  Two identifiers needed care because they carry meaning outside the source:

  - *View type* — `'doomscroll-view'` is persisted in the workspace layout. It is
    now `'bloomscroll-view'`, but the old string is still registered as
    `VIEW_TYPE_LEGACY`, so a tab saved before the rename reopens instead of
    failing with "No view of type doomscroll-view". `activateView` and the
    settings-refresh path both look up either type, so a restored legacy tab is
    reused rather than duplicated.
  - *Settings tab id* — `setting.openTabById('doomscroll')` had to match the
    manifest `id`, which became `bloomscroll-dev` during the rebrand. **This was
    already silently broken**: the in-view settings button opened the settings
    modal but not the plugin's tab. It now reads `this.plugin.manifest.id`, so
    the two cannot drift apart again.

  Deliberately left as-is: the upstream clone URL and image asset in `README.md`,
  and the historical references in this changelog.

- **Version set to `0.1.5-alpha.1`** in `manifest.json`, `package.json`,
  `package-lock.json`, and `versions.json`. Upstream's `0.1.5` was still in
  place despite the fork having diverged substantially, so the two builds were
  indistinguishable by version alone. The semver prerelease form is used rather
  than a bare "alpha-1" because Obsidian parses the manifest version, and a
  prerelease sorts *below* the `0.1.5` it derives from.

- **Rebranded to Bloomscroll** in `manifest.json`:
  - `id`: `doomscroll` → `bloomscroll-dev`
  - `name`: `Doomscroll` → `Bloomscroll`
  - `description`: reworded to match the new name

  The `-dev` suffix on the id matches the vault folder this is installed into.
  Obsidian requires the plugin folder name and manifest `id` to be identical.

  `author` / `authorUrl` still credit yaroshevych, which is correct attribution
  for a fork.

### Added

- **TikTok/Reels-style feed mode** (all five phases of `FEED_UX_PLAN.md`).
  One note fills the viewport; a vertical swipe or scroll advances exactly one
  card; the end of a batch is a full-screen "You're all caught up" panel with a
  **Refresh** button that loads the next batch and returns to the top.

  Batch loading, selection (`selector.ts`), indexing (`indexer.ts`), history,
  and preview extraction are unchanged — this is purely a browsing-UX change.

  - *Snap scrolling* — `scroll-snap-type: y mandatory` on the scroll container,
    with `scroll-snap-stop: always` on each card so a fast flick cannot skip
    past several notes at once. Card content sits in a new
    `.bloomscroll-card-inner` wrapper capped at the reading width, so full-height
    cards don't sprawl on a wide desktop window.
  - *End-of-feed panel* — the old inline "Reshuffle" footer became a full-height
    snap page with a note count and a primary **Refresh** action.
  - *Progress counter* — `3 / 20` in the header, driven by a
    `requestAnimationFrame`-throttled scroll listener that derives the active
    index from `scrollTop / clientHeight`.
  - *View tracking* — the `cardObserver` threshold is now mode-aware: `0.6` in
    feed mode, the original `0.1` in list mode. At `0.1` a full-viewport card
    counted as read while barely on screen.
  - *Snippet prefetch* — the next card's preview renders ahead of arrival, so
    the feed no longer shows "Loading preview…" mid-swipe.
  - *Keyboard* — `↓`/`↑`/`PageDown`/`PageUp`/`Space`/`Shift+Space` move one card,
    registered on the view's own `Scope` so they don't leak into the rest of
    Obsidian.
  - *Tap vs swipe* — a card click only opens the note if the pointer moved less
    than 10px between `pointerdown` and `pointerup`; an explicit **Open note**
    button is the unambiguous affordance.
  - *Scroll restoration* — persisted view state now stores the card **index**
    rather than a pixel `scrollTop`, which broke on resize and rotation. The old
    `scrollTop` field is retained for list mode, where cards vary in height.

- **`feedMode` setting** (`'feed' | 'list'`, default `'feed'`) with a "Feed mode"
  dropdown in settings. All feed CSS is scoped to `.bloomscroll-feed-mode`, so the
  original continuous-scroll list layout is fully preserved and one dropdown away.

- **Bookmark button.** A third floating control toggles the note on the active
  card into Obsidian's Bookmarks, with a Notice confirming either direction and
  an accent-filled icon when the current note is already bookmarked. The state
  re-checks on every card change.

  Bookmarks is a *core internal* plugin: it is absent from `obsidian.d.ts`, the
  user can disable it, and its API carries no stability guarantee. It is reached
  through `app.internalPlugins.getEnabledPluginById('bookmarks')`, and
  `addItem` / `removeItem` / `getBookmarks` are each shape-checked before being
  called — a disabled plugin or a future rename surfaces a Notice instead of
  throwing. Items are written as `{ type: 'file', path }`, matching the format
  already in the vault's `bookmarks.json`.

  Feed mode only: list mode has no single active card, so the button hides
  rather than acting on an arbitrary note.

- **Visual design pass.** The feed moved from plain bordered cards to a
  paper-sheet look:

  - *Title* — `ꕤ bloomscroll` (U+A564 VAI SYLLABLE ZA), in a frosted pill with
    a backdrop blur so it stays legible over whatever card is passing beneath.
  - *Paper card* — a fixed 400x420 sheet with a fibrous texture generated by an
    inline SVG `feTurbulence` filter rather than an image asset, layered
    shadows, embossed text-shadow on descendants, and `--radius-s` corners.
  - *Floating controls* — back, bookmark, and reshuffle became fixed frosted
    pills centred at the bottom of the viewport, spaced 4rem from the midpoint.
    The white ring is an inset shadow rather than a border, so it paints inside
    the button box and the centring maths stays exact.
  - *Header* — transparent, and in feed mode absolutely positioned over the
    scroll area so cards pass underneath it. Laid out as three flex slots
    (progress left, title centred, controls right) where the leading and
    trailing slots share `flex: 1 1 0`, so the title sits on the header's true
    midpoint and does not drift as the progress counter changes width.

  Two bugs surfaced during this work, neither of them cosmetic:

  - The header appeared as an opaque white bar even after being set to
    `transparent`. The colour was Obsidian's own pane background showing
    through: `.bloomscroll-view-container` never painted the feed's ground.
  - Cards were clipped at the header's lower edge. This was a *layout* problem,
    not a colour one — the header occupied its own row in the flex column, so a
    card could never scroll beneath it. Making the header transparent could not
    have fixed it; floating the header did.

- `FEED_UX_PLAN.md` — the phased implementation plan (now executed).
- `CHANGELOG.md` — this file.

### Notes for future work

**Unverified**

- The bookmark button was built by reading the API surface, not by exercising
  it. Two things still need a real click to confirm: that
  `getEnabledPluginById('bookmarks')` returns an instance carrying those methods
  on this Obsidian version, and that `bookmark-check` is a valid Lucide icon
  name — if it is not, the icon renders empty in the bookmarked state.

**Open decisions**

- `FEED_UX_PLAN.md` closes with three design questions that were **not** settled
  before implementing: whether cover images should render full-bleed behind the
  text, whether the header should hide for a more immersive feed, and how wide a
  card should be on desktop. The build takes the conservative option each time —
  stacked title/image/text, header always visible, card content capped at the
  reading width.

**Safe to remove later**

- `VIEW_TYPE_LEGACY` exists only for workspace layouts saved before the rename.
  Once the workspace has been re-saved under `bloomscroll-view`, the legacy
  registration and the dual lookups in `activateView` can go.

**Corrections to the plan**

- The plan named `scope.registerKey` for keyboard handling; the actual Obsidian
  API is `Scope.register(modifiers, key, callback)`, and `this.scope` is
  nullable, so the registration is guarded.

---

## Vault installation notes

Not code changes, but worth recording — these caused real confusion.

- Installed to
  `<vault>/.obsidian/plugins/bloomscroll-dev/` as the three runtime files:
  `main.js`, `manifest.json`, `styles.css`.
- **Two installs existed at once.** The original upstream `doomscroll/` folder
  was still present *and* was the one listed in `community-plugins.json`, so iOS
  kept loading the unfixed copy while the fixed build sat in a folder that was
  never enabled. This is what made the iOS error appear to persist after the fix
  had already been deployed.
- Resolved by: migrating `data.json` (96 previews, 128 history entries) from
  `doomscroll/` into `bloomscroll-dev/`, swapping the entry in
  `community-plugins.json`, and deleting the old folder.
- **iOS caches `main.js` in memory.** After deploying a new build, force-quit
  Obsidian on iOS — a plugin toggle alone will keep running the old bundle.
- If a release build is ever installed as plain `bloomscroll`, it will collide
  with this `bloomscroll-dev` install the same way.

## Build

```bash
npm install
npm run build        # tsc --noEmit + esbuild production bundle → main.js
npm run dev          # esbuild watch mode
```

Deploy = copy `main.js`, `manifest.json`, `styles.css` into the vault's plugin
folder, then reload the plugin (force-quit the app on iOS).
