# TabCloser

A Firefox / Zen browser add-on that auto-closes distracting websites after a chosen amount of **active focus time**, then optionally blocks the site for a chosen duration.

Personal-use, Manifest V3. Requires Firefox 140+ (or Zen on a recent build).

## Features

- Per-site timer that counts only while the tab is focused (alt-tab or switch tabs = pause).
- Auto-close all tabs of a site once the timer hits the limit.
- Optional block period after close (1 min, 30 min, 2 h, whatever).
- Timed rule locks that prevent a rule from being disabled, deleted, or changed before expiry.
- Optional X / Twitter protection that combines X labels with an on-device adult-content classifier for images, GIFs, and sampled video; it has its own timed disable lock.
- Subdomain match — a rule for `twitter.com` also catches `mobile.twitter.com`.
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
3. **Load Temporary Add-on…** and select `manifest.json` from this folder.

## Usage

- Click the TabCloser toolbar icon -> **Open settings** to add a site.
- Each rule has: domain, close-after (minutes), block-after-close toggle + duration, enabled toggle.
- The popup shows current active-time progress and any currently blocked sites.
- Reset the timer or unblock early from the settings page (per-rule buttons).
- Use "Lock rule" after saving an enabled site to protect its configuration for a chosen number of minutes.
- Enable the X / Twitter mature-media blocker and use "Lock protection" to prevent it being turned off until the chosen time expires. Media stays hidden until X metadata or local classification resolves it; uncertain/error cases stay protected.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions, entry points |
| `common.js` | Shared helpers (domain matching, formatting) |
| `background.js` | Focus tracking, auto-close, block enforcement |
| `popup.*` | Status popup (no unblock here) |
| `options.*` | Rule editor + unblock |
| `blocked.*` | Page shown when a blocked site is opened |

## Notes

- Storage lives in `browser.storage.local` — uninstalling clears all rules.
- After editing source files, reload the add-on from `about:debugging` → TabCloser → **Reload**.
- Re-run `npm run build` before reloading whenever classifier or protection source changes.
- The block redirect causes a brief flash before the blocked page appears.
- X media classification is entirely local. Media pixels and model scores are not uploaded or persisted.
- The classifier targets adult sexual content, nudity, pornography, sexualized imagery, and hentai. Other sensitive categories continue to depend on X metadata.
- Safe media can be conservatively blocked. There is intentionally no reveal action while protection is active.
- The private evaluation corpus stays outside Git; see `RELEASE_CHECKLIST.md` for qualification and signing gates.
