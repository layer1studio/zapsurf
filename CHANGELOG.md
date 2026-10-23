# Changelog

## 0.5.7 - 2026-10-23

- Add an in-app Activity inbox for replies, mentions, likes, reposts, and verified incoming zaps, with 30-day activity history, per-account unread state, and foreground polling. Include recent activity on older authored notes.
- Move profile identity beside the ZapSurf home control, reduce the name size, show the connection method beneath it, and make account actions equally sized.
- Add icons for notification types, Activity, and Log out; highlight unread activity in green and remove the Settings button fill.
- Show brand and profile icons when the sidebar is hidden, add horizontal padding to its launcher, and remove the controls summary when minimized.
- Navigate between feed notes with desktop chevrons, mobile swipes, or left/right arrow keys when the sidebar is minimized; use up/down arrows to scroll.

## 0.4.0 - 2026-10-23

- Add shareable root-level profile and note URLs using NIP-19 identifiers, with browser-history navigation and Vercel deep-link rewrites.
- Display recursive reply threads with chronological siblings, capped indentation, and bounded relay queries.
- Poll every minute while the tab is foregrounded for new notes by current-feed authors, visible sidebar interactions, and the open thread, including verified note zaps.
- Pause menu polling when the sidebar is hidden, and stage newly discovered notes behind an insert button to preserve reading position.

## 0.3.2 - 2026-10-22

- Refine the page title and Open Graph/Twitter titles to "ZapSurf | Nostr Notes From Solid Zappers".

## 0.3.1 - 2026-10-22

- Add canonical metadata and SEO/social descriptions focused on ZapSurf's zap-history feed filtering.
- Add the root-level OG image to Open Graph and Twitter large-image previews.

## 0.3.0 - 2026-10-22

- Improve post and reply editors with a full-width desktop composer, a scrollable emoji accordion, live rendered previews, and mention lookup for known profiles and NIP-05 addresses.
- Convert entered npub and selected profile mentions to readable @names while retaining canonical Nostr pubkey references when publishing.
- Show per-relay publishing progress and accepted/attempted totals, including partial success feedback.
- Remove the visible character counter while retaining the editor's 8,000-character limit.

## 0.2.1 - 2026-10-21

- Fix zap invoice requests using an undefined JSON fetch helper.
- Show verified note zaps with sender, amount, and comment.
- Render bare npub and nprofile references as usernames linked to their profiles.
- Prefetch replies and interaction data for notes near the feed viewport, with a bounded in-memory cache.
- Show webpage previews in the note viewer.
- Add a mobile-friendly people dropdown with profile avatars for reposts, quotes, and likes.
- Use the site favicon in the home link and the supplied send icon on the New Note button.

## 0.1.0 - 2026-10-20

- Validate zap receipts and embedded requests, require the recipient's LNURL provider key and a matching invoice amount, and exclude self-zaps from filter totals.
- Show feed notes progressively as each author's zap history is checked, with more detailed loading progress; start reply zap checks alongside remaining thread loading.
- Add a per-thread option to show replies hidden by the zap filter.
- Show interaction counts and rendered media on profile notes, remove the redundant Feed order sort, and make the ZapSurf title return to Home.
- Add focused automated tests for receipt validation.