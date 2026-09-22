# TabCloser

A Firefox / Zen browser add-on that auto-closes distracting websites after a chosen amount of **active focus time**, then optionally blocks the site for a chosen duration.

Personal-use, Manifest V3. Requires Firefox 140+ (or Zen on a recent build).

## Features

- Per-site timer that counts only while the tab is focused (alt-tab or switch tabs = pause).
- Auto-close all tabs of a site once the timer hits the limit.
- Optional block period after close (1 min, 30 min, 2 h, whatever).
- Timed rule locks that prevent a rule from being disabled, deleted, or changed before expiry.
- Optional X / Twitter protection that combines X labels with an on-device adult-content classifier for images, GIFs, and sampled video; it has its own timed disable lock.
- Subdomain match — a rule for `twitter.com` also catches `mobile.twitter.com`. If both have enabled timer rules, the more specific domain controls the timer. Auto-close still closes all tabs matching the expired rule, including subdomains.
- Cooldowns apply across overlapping domains: a subdomain cannot escape an active parent-domain block, and the latest applicable expiry determines when access returns. Duplicate domains are rejected when saving.
- Block screen is friction-only: **no unblock button on the page**. To unblock early, open the add-on settings.

## Install (Zen / Firefox)

### Signed XPI (permanent)

1. Download the latest signed `.xpi` from the [Releases page](https://github.com/PietroFilippo/TabCloser/releases/latest).
2. Drag the file into a Zen / Firefox window, or open it with `Ctrl+O`.
3. Confirm the install prompt.

### Development install (temporary)

Use this when iterating on the source. The add-on unloads on browser restart.

1. Open `about:debugging` in the browser.
2. Click **This Firefox** (Zen exposes the same page).
3. Run `npm install` and `npm run build` from this folder before loading the add-on.
4. **Load Temporary Add-on…** and select `manifest.json` from this folder.

## Usage

- Click the TabCloser toolbar icon -> **Open settings** to add a site.
- Each rule has: domain, close-after (minutes), block-after-close toggle + duration, enabled toggle.
- The popup shows each site as counting, paused, or blocked. Blocked sites show a cooldown instead of a second, reset timer card. Long lists expand with **Show more**, and the settings button stays visible while scrolling.
- Reset the timer or unblock early from the settings page (per-rule buttons).
- Use "Lock rule" after saving an enabled site to protect its configuration for a chosen number of minutes.
- A new subdomain rule cannot override a locked parent timer. Existing duplicate rules from older versions remain editable; resolve duplicates before saving further rule changes.
- Enable either X protection tier and use its lock to prevent disabling it until expiry. X labels protect immediately. The classifier checks images and samples videos; a successful video check takes priority over a noisy thumbnail. Unavailable video checks fall back to the thumbnail, while image-check errors stay covered and retry.
- Click **Why hidden?** on a replacement to see the reason, checked media type, and available model scores. Scores are model signals, not reliable probabilities.
- Right-click a post or media on X and choose **TabCloser → hide this post** or **hide this image / video**. Manual choices survive reloads and work with automatic protection off. Remove individual choices under **Manual hides** in settings, or through **Why hidden?**. Active X locks prevent removal.
- Temporary reveals default **off**. Set a daily allowance in settings (for example, 30 seconds), then hold **Hold to reveal** inside **Why hidden?**. A post gets **three cumulative seconds per local calendar day**, shared across all its images and all tabs. Releasing the button/key, losing focus, navigating, or reaching the deadline hides it again. Videos remain paused and muted. Keyboard: focus the hold button and hold Space or Enter.
- The background process reserves time before revealing and refunds unused time on a clean early release. Refreshes preserve usage; a crash or extension restart can consume the outstanding reservation. Local midnight replenishes the allowance; changing a setting never clears usage. The daily limit may decrease but cannot increase during an active X lock.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions, entry points |
| `common.js` | Shared helpers (domain matching, formatting) |
| `background.js` | Focus tracking, auto-close, block enforcement |
| `popup.*` | Status popup (no unblock here) |
| `options.*` | Rule editor + unblock |
| `x-interactions.js` | Reason panel, manual hides, hold-to-reveal presentation |
| `x-user-controls.js` | Persistent manual identities and shared reveal accounting |
| `blocked.*` | Page shown when a blocked site is opened |

## Notes

- Storage lives in `browser.storage.local` — uninstalling clears all rules.
- After editing source files, reload the add-on from `about:debugging` → TabCloser → **Reload**.
- Re-run `npm run build` before reloading whenever classifier or protection source changes.
- The block redirect causes a brief flash before the blocked page appears.
- X media classification is entirely local. Media pixels and model scores are not uploaded or persisted.
- The classifier targets adult sexual content, nudity, pornography, sexualized imagery, and hentai. Other sensitive categories continue to depend on X metadata.
- Safe media can still be incorrectly blocked. Optional reveals are temporary presentation overrides and never change a classifier verdict or add a safe exception.
- Manual post/media identities and daily reveal usage are saved locally; image pixels and diagnostic scores are not persisted by the extension. Removing a manual hide does not override X labels or classifier results.
- The private evaluation corpus stays outside Git; see `RELEASE_CHECKLIST.md` for qualification and signing gates.
