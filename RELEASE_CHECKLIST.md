# TabCloser 0.3.0 release checklist

## Automated gates

1. Use Node 22 and npm 10, then run `npm ci`.
2. Run `npm test`; all tests must pass.
3. Run the private corpus evaluator. Known misses must be 100% protected, unsafe recall at least 98%, and clearly-safe release at least 90%.
4. Run `npm run build` and `npm run lint:extension` with no errors.
5. Run `npm run package`; inspect the archive and confirm it contains no corpus media, credentials, source maps, development tools, or remote code.

## Firefox and Zen QA

- Test a clean install and an upgrade from 0.2.0; rules, timers, blocks, X-protection state, and locks must survive.
- Test X Home, Search, TweetDetail, photo viewer, cards, single/multi-image tweets, GIFs, and videos.
- Repeat known misses with VPN enabled and disabled.
- Confirm X-labelled media blocks without waiting for local inference.
- Confirm safe media remains hidden while pending and becomes visible only after a safe verdict.
- Confirm unsafe, borderline, timeout, corrupt-model, offline, unsupported-video, and CORS failures remain protected.
- Confirm disabling unlocked protection restores pending/protected DOM and a lock prevents disabling.
- Confirm scrolling and tab switching remain responsive with multiple visible media items.

## Signing and release

1. Build a source archive containing the lockfile and reproducible build instructions for Mozilla review.
2. Set `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` only in the shell environment.
3. Sign for self-distribution with `npx web-ext sign --source-dir dist --channel unlisted --api-key $env:AMO_JWT_ISSUER --api-secret $env:AMO_JWT_SECRET`.
4. Install and smoke-test the returned signed XPI.
5. Publish the signed XPI, SHA-256 checksum, source tag, release notes, model version, and false-positive disclosure on GitHub Releases.
6. Retain the previous signed XPI as the rollback artifact.
