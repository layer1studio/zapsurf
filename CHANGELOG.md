# Changelog

## 0.1.0 - 2026-10-20

- Validate zap receipts and embedded requests, require the recipient's LNURL provider key and a matching invoice amount, and exclude self-zaps from filter totals.
- Show feed notes progressively as each author's zap history is checked, with more detailed loading progress; start reply zap checks alongside remaining thread loading.
- Add a per-thread option to show replies hidden by the zap filter.
- Show interaction counts and rendered media on profile notes, remove the redundant Feed order sort, and make the ZapSurf title return to Home.
- Add focused automated tests for receipt validation.