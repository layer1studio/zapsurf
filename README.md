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
- Upload images and videos from note, reply, and private-message composers by picker, paste, or drag/drop to your first advertised Blossom server (kind 10063). If none is listed, save an account-specific fallback server in Settings. Uploads require a signer and an HTTPS, browser-accessible Blossom server. Browser-decodable images are converted to WebP before upload to strip embedded geodata/metadata, videos have file metadata stripped, and animated GIFs are preserved; removing a URL from a draft does not delete the uploaded file.
- Read quoted notes inline with their images, videos and link previews. Nested quotes are bounded, and unavailable notes retain an external link.
- Send Lightning zaps with WebLN or a Nostr Wallet Connect wallet, with configurable one-tap amounts.

## Private messages

Open **Messages** beside **New note**, or the envelope icon on another person's profile, to use one-to-one text messages. NIP-17 is the default, using NIP-44 v2 encryption and NIP-59 gift wraps. Existing NIP-04 conversations can also be read. The per-conversation **Use legacy DM (NIP-04)** switch explicitly enables legacy sending; it is off by default and resets when changing conversations or closing Messages. Legacy messages expose sender, recipient, and timing metadata. There is no automatic downgrade. Groups, attachments, and read receipts are not supported.

Your signer must support NIP-44 encryption and decryption for secure mode, or NIP-04 encryption and decryption for legacy mode. Browser extensions, NIP-46 remote signers, and unlocked encrypted local keys are supported; read-only accounts cannot read or send DMs. Existing remote-signer connections may need additional encryption, kind-13 or kind-4 signing, and relay-authentication permissions.

Set 1-3 `wss://` relays under **Inbox relays** in Messages. Choose relays that accept kind 1059 and preferably enforce NIP-42 authentication and recipient-only reads. ZapSurf advertises them in a public kind-10050 event. In secure mode, each message is sent only to the recipient's advertised DM relays, with a separate encrypted history copy sent to your own advertised inbox. Send stays disabled while recipient readiness is checked or no recipient inbox is advertised. Legacy mode uses existing account relays and does not require kind-10050 inbox lists; relay acceptance does not guarantee the recipient supports legacy messages. Failed copies can be retried while the inbox remains open; retries reuse the original encrypted event. Relay acceptance is not a delivery or read receipt.

The inbox initially requests up to 200 recent secure envelopes per relay without an age cutoff, plus up to 100 received and 100 sent legacy messages from your account's existing relays. Inbox-list discovery also checks account relay hints. **Load older messages** fetches earlier history. Legacy history can be read without configuring a new NIP-17 inbox; sending secure messages still requires advertised DM inbox relays. Existing signers may request `nip04_decrypt` permission for legacy history. The in-memory view is bounded to 1,000 messages. Decrypted messages and drafts are not persisted, do not load remote media or link previews, and are cleared when Messages closes or the account changes. History availability depends on relay retention.

NIP-17 does not provide cryptographic forward secrecy or post-compromise security. Someone who obtains an identity private key can decrypt previously recorded messages. Relays can still observe recipient routing and connection metadata; gift wrapping does not provide network anonymity.

Run the automated tests with `node --test test/*.test.mjs`.

## TODO

- [ ] Build a primary navigation menu for moving between feeds, profiles, messages, and settings.
- [x] Add direct messages, including an inbox, conversation view, and encrypted message send/receive.
- [x] Use NIP-17/NIP-44/NIP-59 with dedicated DM relay discovery and signer capability handling; no automatic legacy downgrade.
- [ ] Add automated tests for feed loading, signing, and zap flows.
- [ ] Review keyboard navigation and mobile layouts as the menu and messaging views are added.