# TabCloser 0.3.0 release checklist

## Automated gates

1. Use Node 22 and npm 10, then run `npm ci`.
2. Run `npm test`; all tests must pass.
3. Run the private corpus evaluator. Known misses must be 100% protected, unsafe recall at least 98%, and clearly-safe release at least 90%.
4. Run `npm run build` and `npm run lint:extension` with no errors.
5. Run `npm run package`; inspect the archive and confirm it contains no corpus media, credentials, source maps, development tools, or remote code.

## Firefox and Zen QA

- Check the popup with 0, 1, 5, and 10 tracked sites, mixed paused/blocked sites, and long domains. Verify Show more/fewer, keyboard focus, scrolling, and the pinned settings button.
- Open the popup on `blocked.html` and an internal browser page. The blocked domain should appear once with its cooldown; internal pages must never show an extension UUID as a site.
- Switch between tracked sites/windows, reset an active timer, and let a timer expire. Only focused time should count; stale timeout/alarm notifications must not close a different site early.
- Test parent/subdomain timer precedence, overlapping cooldowns, duplicate-domain validation, and locked-parent override prevention.
- Test a clean install and an upgrade from 0.2.0; rules, timers, blocks, X-protection state, and locks must survive.
- Test X Home, Search, TweetDetail, photo viewer, cards, single/multi-image tweets, GIFs, and videos.
- Repeat known misses with VPN enabled and disabled.
- Confirm X-labelled media blocks without waiting for local inference.
- Confirm safe media remains hidden while pending and becomes visible only after a safe verdict.
- Confirm X-labelled and model-flagged media remain protected. Image-check failures should stay covered and retry. Unavailable/incomplete video checks must retain a flagged thumbnail; absent/unreadable thumbnails alone do not protect a video.
- Recheck the Coltrane false-positive post `2101422716305744244`: a thumbnail score near 0.83 must no longer end the check before video sampling. Verify its real sampled frames as well as known mature-video cases; mocked safe-frame tests do not establish corpus accuracy.
- Check Why hidden for X labels, individual images, video frames, thumbnail fallback, manual choices, and failures. Clicking controls must not navigate or open the painting viewer.
- Right-click-hide one image and a whole text-only post. Verify persistence, timeline/detail views, quoted-post isolation, removal, and automatic protection off. Locks must prevent removing manual hides.
- Configure 4 seconds/day and reveal two different posts: at most 3 seconds on the first and 1 on the second. Repeat a hold after early release, refresh, restart, and use concurrent tabs. No action may reset usage except the next local calendar day.
- During a reveal test release, blur, tab changes, navigation, DOM remounts, and the deadline. Text and media must rehide; videos must never autoplay. Check pointer and keyboard holds.
- Confirm an active X lock prevents increasing/enabling the reveal allowance but allows lowering it. Disabling/re-enabling never refills the allowance.
- Confirm disabling unlocked protection restores pending/protected DOM and a lock prevents disabling.
- Confirm scrolling and tab switching remain responsive with multiple visible media items.

## Signing and release

1. Build a source archive containing the lockfile and reproducible build instructions for Mozilla review.
2. Set `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` only in the shell environment.
3. Sign for self-distribution with `npx web-ext sign --source-dir dist --channel unlisted --api-key $env:AMO_JWT_ISSUER --api-secret $env:AMO_JWT_SECRET`.
4. Install and smoke-test the returned signed XPI.
5. Publish the signed XPI, SHA-256 checksum, source tag, release notes, model version, and false-positive disclosure on GitHub Releases.
6. Retain the previous signed XPI as the rollback artifact.
