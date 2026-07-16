(function initXMetadata(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabCloserXMetadata = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createXMetadata() {
  function normalizeMediaUrl(value) {
    try {
      const url = new URL(value);
      return url.origin + url.pathname;
    } catch {
      return null;
    }
  }

  function containsAgeVerificationPrompt(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false;
    seen.add(value);
    if (value.interstitial_action === 'AgeVerificationPrompt') return true;
    return Object.values(value).some(child => containsAgeVerificationPrompt(child, depth + 1, seen));
  }

  function containsSensitivityMarker(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false;
    seen.add(value);
    if (value.possibly_sensitive === true ||
        value.sensitive_media_warning ||
        value.interstitial_action === 'AgeVerificationPrompt') return true;
    return Object.values(value).some(child => containsSensitivityMarker(child, depth + 1, seen));
  }

  function tweetIdFromNode(node) {
    const legacy = node?.legacy && typeof node.legacy === 'object' ? node.legacy : node;
    const value = node?.rest_id || legacy?.id_str || node?.id_str;
    return value == null ? null : String(value);
  }

  function authorResultFromTweetNode(node) {
    return node?.core?.user_results?.result ||
      node?.author_results?.result ||
      node?.user_results?.result;
  }

  function authorIdFromTweetNode(node) {
    const legacy = node?.legacy && typeof node.legacy === 'object' ? node.legacy : node;
    const userResult = authorResultFromTweetNode(node);
    const value = legacy?.user_id_str ||
      node?.user_id_str ||
      userResult?.rest_id ||
      userResult?.legacy?.id_str;
    return value == null ? null : String(value);
  }

  function mediaFromTweetNode(node) {
    const legacy = node?.legacy && typeof node.legacy === 'object' ? node.legacy : node;
    return legacy?.extended_entities?.media || legacy?.entities?.media ||
      node?.extended_entities?.media || node?.entities?.media;
  }

  function isTweetNode(node, media, pairedTweet = false) {
    const legacy = node?.legacy && typeof node.legacy === 'object' ? node.legacy : node;
    return pairedTweet ||
      Array.isArray(media) ||
      /^Tweet/.test(node?.__typename || '') ||
      !!node?.core?.user_results ||
      legacy?.conversation_id_str != null ||
      legacy?.full_text != null;
  }

  function authorHasSensitivityMarker(node) {
    const author = authorResultFromTweetNode(node);
    const legacy = author?.legacy && typeof author.legacy === 'object' ? author.legacy : author;
    return hasDirectSensitivityMarker(author) || hasDirectSensitivityMarker(legacy) ||
      hasSensitiveProfileInterstitial(author) || hasSensitiveProfileInterstitial(legacy);
  }

  // X stamps accounts that habitually post mature media with a profile-level
  // interstitial. Unlike mediaVisibilityResults, this is author account state,
  // not per-viewer visibility, so it survives VPN exit regions that omit the
  // per-tweet interstitial metadata.
  function hasSensitiveProfileInterstitial(value) {
    return !!value && typeof value === 'object' &&
      typeof value.profile_interstitial_type === 'string' &&
      /sensitive/i.test(value.profile_interstitial_type);
  }

  function hasDirectSensitivityMarker(value) {
    return !!value && typeof value === 'object' &&
      (value.possibly_sensitive === true || !!value.sensitive_media_warning);
  }

  const diagnosticKeyPattern = /sensitive|adult|nudity|visibility|interstitial|limited|withheld|restriction|tombstone/i;

  function summarizeDiagnosticValue(value) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 120);
    if (Array.isArray(value)) return 'array(' + value.length + ')';
    return 'object(' + Object.keys(value).slice(0, 10).join(',') + ')';
  }

  // Privacy-preserving diagnostics: report only structural tweet IDs, type
  // names, media counts, and fields whose names indicate visibility/safety.
  // Never include post text, usernames, or raw media URLs.
  function summarizeSensitivitySignals(payload, targetTweetId = null) {
    const candidates = [];
    const fields = [];
    const seen = new Set();
    const target = targetTweetId == null ? null : String(targetTweetId);

    function inspect(node, path = '$', depth = 0) {
      if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
      seen.add(node);
      const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : node;
      const id = node.rest_id || legacy.id_str || node.id_str;
      const media = legacy.extended_entities?.media || legacy.entities?.media ||
        node.extended_entities?.media || node.entities?.media;
      if (id && (!target || String(id) === target) && candidates.length < 20) {
        const authorResult = authorResultFromTweetNode(node);
        const authorLegacy = authorResult?.legacy && typeof authorResult.legacy === 'object'
          ? authorResult.legacy
          : authorResult;
        candidates.push({
          id: String(id),
          typename: typeof node.__typename === 'string' ? node.__typename : null,
          mediaCount: Array.isArray(media) ? media.length : 0,
          possiblySensitive: legacy.possibly_sensitive ?? node.possibly_sensitive ?? null,
          hasSensitiveWarning: !!(legacy.sensitive_media_warning || node.sensitive_media_warning),
          authorId: authorIdFromTweetNode(node),
          authorPossiblySensitive: authorLegacy?.possibly_sensitive ?? null,
          authorProfileInterstitialType: authorLegacy?.profile_interstitial_type ?? null,
          authorHasSensitiveWarning: !!authorLegacy?.sensitive_media_warning,
        });
      }

      for (const [key, child] of Object.entries(node)) {
        const childPath = path + '.' + key;
        if (diagnosticKeyPattern.test(key) && fields.length < 40) {
          fields.push({ path: childPath, key, value: summarizeDiagnosticValue(child) });
        }
        if (child && typeof child === 'object') inspect(child, childPath, depth + 1);
      }
    }

    inspect(payload);
    return {
      targetTweetId: target,
      topLevelKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
      candidates,
      fields,
    };
  }

  function extractAgeVerificationTweetIds(payload) {
    const tweetIds = new Set();
    const seen = new Set();

    function inspect(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (containsAgeVerificationPrompt(node.mediaVisibilityResults)) {
        const tweetId = tweetIdFromNode(node.tweet);
        if (tweetId) tweetIds.add(tweetId);
      }
      for (const child of Object.values(node)) {
        if (child && typeof child === 'object') inspect(child);
      }
    }

    inspect(payload);
    return [...tweetIds];
  }

  function extractDirectVideoSources(payload) {
    const selected = new Map();
    const seen = new Set();

    function variantRank(variant) {
      const bitrate = Number(variant?.bitrate);
      return Number.isFinite(bitrate) && bitrate >= 0 ? bitrate : Number.MAX_SAFE_INTEGER;
    }

    function isDirectMp4(variant) {
      if (!variant?.url || typeof variant.url !== 'string') return false;
      if (variant.content_type === 'video/mp4') return true;
      try {
        return new URL(variant.url).pathname.toLowerCase().endsWith('.mp4');
      } catch {
        return false;
      }
    }

    function inspect(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      const media = mediaFromTweetNode(node);
      const tweetId = tweetIdFromNode(node);
      if (tweetId && isTweetNode(node, media) && Array.isArray(media)) {
        for (const item of media) {
          for (const variant of item?.video_info?.variants ?? []) {
            if (!isDirectMp4(variant)) continue;
            const rank = variantRank(variant);
            const previous = selected.get(tweetId);
            if (!previous || rank < previous.rank) selected.set(tweetId, { rank, url: variant.url });
          }
        }
      }
      for (const child of Object.values(node)) {
        if (child && typeof child === 'object') inspect(child);
      }
    }

    inspect(payload);
    return Object.fromEntries([...selected].map(([tweetId, value]) => [tweetId, value.url]));
  }

  function extractSensitiveMedia(payload) {
    const urls = new Set();
    const tweetIds = new Set();
    const seen = new Set();

    function addUrl(value) {
      const normalized = normalizeMediaUrl(value);
      if (normalized) urls.add(normalized);
    }

    function inspect(node, inheritedSensitive = false, pairedTweet = false) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);

      const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : node;
      const media = mediaFromTweetNode(node);
      const tweetId = tweetIdFromNode(node);
      const tweetNode = isTweetNode(node, media, pairedTweet);
      const authorSensitive = Array.isArray(media) && media.length > 0 && authorHasSensitivityMarker(node);
      const sensitive = tweetNode && (inheritedSensitive ||
        hasDirectSensitivityMarker(node) ||
        hasDirectSensitivityMarker(legacy) ||
        authorSensitive ||
        (Array.isArray(media) && media.some(item => containsSensitivityMarker(item))));

      // X visibility wrappers can keep the tweet-level sensitivity flag while
      // moving or redacting extended_entities. Preserve the authoritative ID
      // even when this response contains no inline media array.
      if (tweetId && tweetNode && sensitive) tweetIds.add(String(tweetId));
      if (Array.isArray(media) && media.length && sensitive) {
        for (const item of media) {
          addUrl(item.media_url_https);
          addUrl(item.media_url);
          addUrl(item.video_info?.poster);
          for (const variant of item.video_info?.variants ?? []) addUrl(variant.url);
        }
      }

      const pairedTweetSensitive = containsSensitivityMarker(node.mediaVisibilityResults);
      for (const [key, child] of Object.entries(node)) {
        if (child && typeof child === 'object') {
          inspect(child, pairedTweetSensitive && key === 'tweet', key === 'tweet');
        }
      }
    }

    inspect(payload);
    return { urls: [...urls], tweetIds: [...tweetIds] };
  }

  return {
    containsSensitivityMarker,
    extractAgeVerificationTweetIds,
    extractDirectVideoSources,
    extractSensitiveMedia,
    normalizeMediaUrl,
    summarizeSensitivitySignals,
  };
});
