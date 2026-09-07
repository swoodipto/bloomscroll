# Plan: TikTok-style one-card-at-a-time feed

## Goal & scope

Change **only the browsing UX** — one note fills the viewport, vertical
swipe/scroll advances exactly one card, and at the end of the batch you hit a
full-screen "Refresh" panel that loads the next batch and returns you to the top.

Explicitly unchanged: indexing (`indexer.ts`), batch selection (`selector.ts`),
history (`history.ts`), preview extraction (`extract.ts`), settings schema, and
the `batchSize` semantics. Same number of cards per batch, same selection
algorithm.

## Key insight

`.bloomscroll-body` (`styles.css:71`) is already a single `overflow-y: auto`
container with cards as direct children. CSS scroll-snap turns that into a
one-at-a-time feed with no restructuring of the DOM. The current code already has
the right bones — this is not a rebuild of the view, it changes how it lays out
and how it ends.

## Phase 1 — Snap scrolling (CSS)

In `styles.css`:

- `.bloomscroll-body`: add `scroll-snap-type: y mandatory;` and
  `scroll-behavior: smooth;`. Remove `padding: 1rem` (it breaks snap alignment)
  and drop the `max-width` clamp so cards can go edge-to-edge; re-apply the width
  limit on inner card content instead.
- `.bloomscroll-card`: `height: 100%; scroll-snap-align: start;
  scroll-snap-stop: always;` — `scroll-snap-stop: always` is the critical
  property, it prevents a fast flick from skipping past cards. Remove
  `margin-bottom`, make it a flex column that centers its content.
- Card internals become a centered, max-width column so long notes don't sprawl
  on desktop.
- `.bloomscroll-card-image`: raise `max-height` and use `object-fit: cover` so
  images fill the panel rather than sitting in a 240px box.
- `.bloomscroll-card-snippet-markdown`: replace the fixed `max-height: 15em` with
  `flex: 1` + `overflow: hidden` and a bottom fade mask, so text fills whatever
  space the viewport gives it.

Mobile note: iOS needs `height: 100%` on the snap container with
`-webkit-overflow-scrolling: touch`, and `env(safe-area-inset-*)` padding on card
content so titles don't sit under the notch.

## Phase 2 — End-of-feed panel

Today `renderBatchIntoContainer` (`view.ts:388`) appends a small
`.bloomscroll-reshuffle-section` after the cards. Change it to a **full-height
snap panel** — same `height: 100%; scroll-snap-align: start` as a card —
containing:

- "You're all caught up" heading
- Count of notes just seen
- A large primary **Refresh** button

On click: call the existing `showNewBatch()`, then scroll the container back to
`scrollTop = 0`. Because `showNewBatch` already rebuilds the DOM, the reset is a
one-liner added after it resolves.

## Phase 3 — Card index tracking & progress

Add to `BloomscrollView`:

- `currentCardIndex: number`
- A scroll listener (throttled via `requestAnimationFrame`) that computes the
  active index from `scrollTop / clientHeight`

Uses:

- **Progress indicator** — a thin segmented bar or "3 / 20" in the header, so the
  feed has a sense of length. TikTok-like, and cheap.
- **View tracking** — raise the `cardObserver` threshold from `0.1`
  (`view.ts:377`) to `~0.6`. At 0.1 a card counts as "viewed" while barely on
  screen; in a full-viewport feed that's wrong. 0.6 means it's genuinely the
  active card.
- **Snippet rendering** — currently rendered when a card intersects. Change to
  render the active card **plus one ahead**, so the next card is ready before you
  reach it and you never see "Loading preview…".

## Phase 4 — Keyboard & polish

- `↓`/`↑`/`Space`/`PageDown` → scroll one card. Register via `scope.registerKey`
  so it doesn't leak to the rest of Obsidian.
- Card click currently opens the note (`view.ts:596`). In a full-screen feed an
  accidental tap while swiping would be disruptive — so gate it: only open if the
  pointer moved less than ~10px between `pointerdown` and `pointerup`. Add an
  explicit "Open note" button to the card as the unambiguous affordance.
- `restoreScrollPosition` (`view.ts:284`) stores a raw pixel `scrollTop`. Change
  persisted state to store the **card index** instead and scroll to
  `index * clientHeight` — pixel offsets break when the viewport is resized or
  rotated.

## Phase 5 — Settings toggle

Add `feedMode: 'feed' | 'list'` to `PluginSettings` (default `'feed'`), toggling
a `.bloomscroll-feed-mode` class on the container. All Phase 1 CSS nests under
that class, so the old list layout stays intact and reachable. This makes the
change reversible without a code revert, and gives a fallback if the snap feed
misbehaves on some device.

## Risks

| Risk | Mitigation |
|---|---|
| `scroll-snap-stop: always` has patchy old-WebKit support | Feed still works, just skippable on a fast flick; acceptable degradation |
| Long notes overflow a fixed-height card | Fade mask + "Open note" button; snippet is a preview, not the whole note |
| Snap fights momentum scrolling on iOS | Test on device; `mandatory` → `proximity` is the escape hatch |
| Existing `data.json` has no `feedMode` | Settings loader already defaults missing keys (same pattern as `simplifiedView`, `view.ts:524`) |

## Suggested sequencing

1 → 2 gets a working TikTok feed to try on the phone. 3 → 4 is polish. 5 last,
once the feed layout has settled. Recommended: stop after Phase 2 and actually
use it for a day before committing to the rest.

## Open questions

1. **Image-heavy vs text notes** — TikTok is media-first. Should a note with a
   cover image render it full-bleed behind the text, or keep today's stacked
   title/image/text?
2. **Header** — keep it visible (with progress), or hide it for a truly immersive
   feed and rely on gestures?
3. **Desktop** — full-viewport cards on a wide monitor can look sparse. Cap card
   width and center it, or go genuinely full-width?
