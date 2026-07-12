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

  function containsSensitivityMarker(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false;
    seen.add(value);
    if (value.possibly_sensitive === true || value.sensitive_media_warning) return true;
    return Object.values(value).some(child => containsSensitivityMarker(child, depth + 1, seen));
  }

  function extractSensitiveMedia(payload) {
    const urls = new Set();
    const tweetIds = new Set();
    const seen = new Set();

    function addUrl(value) {
      const normalized = normalizeMediaUrl(value);
      if (normalized) urls.add(normalized);
    }

    function inspect(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);

      const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : node;
      const media = legacy.extended_entities?.media || legacy.entities?.media ||
        node.extended_entities?.media || node.entities?.media;

      if (Array.isArray(media) && media.length && containsSensitivityMarker(node)) {
        const tweetId = node.rest_id || legacy.id_str || node.id_str;
        if (tweetId) tweetIds.add(String(tweetId));
        for (const item of media) {
          addUrl(item.media_url_https);
          addUrl(item.media_url);
          addUrl(item.video_info?.poster);
          for (const variant of item.video_info?.variants ?? []) addUrl(variant.url);
        }
      }

      for (const child of Object.values(node)) {
        if (child && typeof child === 'object') inspect(child);
      }
    }

    inspect(payload);
    return { urls: [...urls], tweetIds: [...tweetIds] };
  }

  return { containsSensitivityMarker, extractSensitiveMedia, normalizeMediaUrl };
});
