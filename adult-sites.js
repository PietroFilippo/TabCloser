// Exact domain / subdomain matching. Never match keywords or URL paths.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabCloserAdultSites = api;
})(globalThis, function() {
  function match(url, domains) {
    let host;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    } catch { return null; }
    while (host.includes('.')) {
      if (domains.has(host)) return host;
      host = host.slice(host.indexOf('.') + 1);
    }
    return null;
  }
  let loading;
  function load() {
    if (!loading) loading = (async () => {
      const [response, metadataResponse] = await Promise.all([
        fetch(browser.runtime.getURL('data/adult-domains.txt.gz')),
        fetch(browser.runtime.getURL('data/adult-list.json')),
      ]);
      if (!response.ok || !metadataResponse.ok) throw new Error('Bundled adult-site list is unavailable. Reload the extension.');
      const text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
      const metadata = await metadataResponse.json();
      const domains = new Set(text.trim().split('\n'));
      if (domains.size !== metadata.count || domains.size < 10000) throw new Error('Bundled adult-site list is incomplete. Rebuild the extension.');
      return { domains, metadata };
    })().catch(error => { loading = null; throw error; });
    return loading;
  }
  return { match, load };
});
