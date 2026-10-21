# Changelog

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