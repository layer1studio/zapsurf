# ZapSurf

ZapSurf is a browser-based Nostr client built to create a higher-signal feed with less bot and AI noise. It uses authors' recent outgoing Lightning zap activity to help distinguish active participants from low-signal accounts.

## Versioning

The current version is recorded in [`VERSION`](VERSION). Releases follow semantic versioning: increment the patch number for fixes, the minor number for backward-compatible features, and the major number for breaking changes. See [`CHANGELOG.md`](CHANGELOG.md) for release notes.

## Run locally

You need Node.js/npm and an internet connection. From the repository root, start a static server:

```sh
npx --yes http-server . -a 127.0.0.1 -p 8080 -c-1
```

Then open <http://127.0.0.1:8080>. ZapSurf loads its Nostr libraries from `esm.sh`, so the app needs internet access in the browser as well.

## High-signal feed filter

ZapSurf checks Nostr zap receipts from the last 14 days and totals validated outgoing sats for each note author. A receipt counts only when its signature verifies against the recipient's LNURL provider key, its embedded zap request is valid and signed by the sender, and its invoice amount matches the request. Zaps to the sender's own pubkey do not count. By default, a note or reply is visible when its author has sent at least 100 sats during that period. The filter uses outgoing zap activity, not zaps received by the note or the signed-in reader's own zap history. Your own notes always pass the filter.

Zap activity is a signal, not proof that an account is human or that its posts are high quality. Receipts rely on the recipient's LNURL provider and cannot independently prove payment; a dishonest provider can still issue false receipts. Profiles without usable LNURL zap metadata will not contribute to the filter. This heuristic can hide genuine users and does not guarantee that bot or AI accounts will be excluded.

Set the minimum to 0 in Settings to show everyone. In the Home feed, you can also choose to show all followed accounts regardless of their zap activity. Replies use the same author-based filter.

## Other features

- Browse Explore and Trending feeds, or a personalized Home feed when signed in; sort by recency, zaps, likes, replies, reposts, and engagement.
- Read note threads and profiles, follow accounts, and view recent profile notes.
- Open **All Activity** from a profile for a newest-first timeline of posts, replies, likes/reactions, reposts, verified sent zaps, and new follows, with target-post details and older activity available through Load more. New follows require historical contact-list snapshots; many relays retain only the latest list, so follow history may be unavailable or incomplete. Activity history also depends on public relay retention.
- Open shareable profiles at `/<npub>` and notes at `/<note>`; the NIP-19 prefix identifies the view. Direct links require the app-shell rewrite configured for Vercel.
- Share activity pages at `/<npub>/activity` or `/<nprofile>/activity`. For local deep-link refresh support, append `--proxy 'http://127.0.0.1:8080?'` to the server command above.
- Sign in with a NIP-07 browser extension, a NIP-46 remote signer, an encrypted private key, or in read-only mode.
- Write notes and replies, and like, repost, or quote notes.
- Send Lightning zaps with WebLN or a Nostr Wallet Connect wallet, with configurable one-tap amounts.

## TODO

- [ ] Build a primary navigation menu for moving between feeds, profiles, messages, and settings.
- [ ] Add direct messages, including an inbox, conversation view, and encrypted message send/receive.
- [ ] Decide which encrypted DM protocols and compatibility paths to support; handle relay discovery and available signer capabilities.
- [ ] Add automated tests for feed loading, signing, and zap flows.
- [ ] Review keyboard navigation and mobile layouts as the menu and messaging views are added.