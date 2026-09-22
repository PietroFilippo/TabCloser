// User-facing controls are separate from classifier verdicts. A reveal only
// changes presentation; it never marks media safe or resumes video playback.
(() => {
  let snapshot = { posts: [], media: [], revealDailySec: 0, locked: false };
  let posts = new Set(), media = new Set();
  let contextTarget = null, panel = null, panelRoot = null, allowanceText = null, holdButton = null;
  let holding = false, requestGeneration = 0, lease = null, revealTimer = null, refreshTimer = null;
  let allowanceTimer = null;
  let revealStarted = 0, revealDuration = 0, revealPage = '';
  const marked = new Set();
  const manualRoots = new Set();
  const send = message => browser.runtime.sendMessage(message);
  const seconds = ms => (Math.max(0, ms || 0) / 1000).toFixed(1);

  function manuallyHidden(root) {
    return posts.has(statusIdFor(root)) || media.has(stableMediaVerificationKey(root));
  }
  function button(label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (action) element.addEventListener('click', action);
    return element;
  }
  function isolateControls(element) {
    for (const type of ['click', 'auxclick', 'dblclick', 'keydown', 'keyup', 'pointerdown', 'pointerup']) {
      element.addEventListener(type, event => {
        // Media controls can live inside X's photo link. Cancel its default
        // navigation and stop the event before reaching X's delegated handlers.
        if (['click', 'auxclick', 'dblclick'].includes(type)) event.preventDefault();
        event.stopPropagation();
      });
    }
  }
  function explanation(root) {
    const reason = root.dataset.tabcloserMediaReason;
    if (reason === 'manual') return 'You chose to hide this ' + (posts.has(statusIdFor(root)) ? 'post' : 'image or video') + '. The choice is saved on this device.';
    if (reason === 'metadata') return 'X supplied a sensitive-content label or warning for this media, post, or author.';
    if (reason !== 'visual') return 'The media could not be checked (' + (reason || 'unknown error') + '). It stays covered while TabCloser retries when possible.';
    const decision = TabCloserXCoordinator.decisionFor(root);
    if (!decision) return 'The on-device model flagged this media during an earlier check in this page. Models can make mistakes.';
    let text = 'The on-device model flagged the ' + decision.source + '.';
    if (Number.isFinite(decision.adultScore)) text += ' Score ' + decision.adultScore.toFixed(3) + ', cutoff ' + decision.threshold.toFixed(2) + ' (' + decision.sensitivity + ').';
    if (decision.frames?.length) {
      text += ' Checked ' + decision.samplesChecked + ' frame(s); decision: ' + decision.aggregate + '. Frame scores: ' +
        decision.frames.map(frame => frame.t + 's: ' + frame.squash + (frame.crop == null ? '' : ' / crop ' + frame.crop)).join('; ') + '.';
    }
    if (decision.fallback) text += ' ' + decision.fallback + '; the thumbnail was used as a fallback.';
    return text + ' Scores are model signals, not certainty. Harmless media can be flagged.';
  }
  function decorate(root, state) {
    if (state !== 'protected') return;
    const overlay = overlayFor(root);
    if (!overlay || overlay.querySelector('.tabcloser-controls')) return;
    const tools = document.createElement('div');
    tools.className = 'tabcloser-controls tabcloser-media-actions';
    isolateControls(tools);
    tools.appendChild(button('Why hidden?', () => openPanel(root)));
    overlay.appendChild(tools);
    if (lease) paintReveal();
  }
  function closePanel() {
    stopReveal();
    clearInterval(allowanceTimer); allowanceTimer = null;
    const previousRoot = panelRoot;
    panel?.remove(); panel = null; panelRoot = null; holdButton = null; allowanceText = null;
    overlayFor(previousRoot || document.documentElement)?.querySelector('button')?.focus();
  }
  function messagePanel(text) {
    closePanel();
    panel = document.createElement('section');
    panel.className = 'tabcloser-controls tabcloser-control-panel';
    isolateControls(panel);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'TabCloser');
    const title = document.createElement('strong'); title.textContent = 'TabCloser';
    const content = document.createElement('p'); content.textContent = text;
    panel.append(title, button('Close', closePanel), content);
    document.documentElement.appendChild(panel);
    panel.querySelector('button').focus();
  }
  async function updateAllowance(root) {
    const target = panel;
    const result = await send({ type: 'xControlGet', postId: statusIdFor(root) }).catch(() => null);
    if (target !== panel || !result?.ok || lease || holding) return;
    allowanceText.textContent = result.revealDailySec > 0
      ? seconds(result.dailyMs) + 's left today · ' + seconds(result.postMs) + 's left for this post. Resets at local midnight.'
      : 'Temporary reveals are off. Set a daily allowance in TabCloser settings before locking protection.';
    holdButton.disabled = !statusIdFor(root) || result.revealDailySec <= 0 || result.dailyMs <= 0 || result.postMs <= 0;
  }
  function openPanel(root) {
    messagePanel(explanation(root));
    panelRoot = root;
    const details = document.createElement('p');
    details.className = 'tabcloser-control-note';
    details.textContent = 'Hold to reveal the post’s hidden media and text for up to three seconds. Videos remain paused. Let go or leave this tab to hide again.';
    allowanceText = document.createElement('p');
    allowanceText.setAttribute('role', 'status');
    allowanceText.textContent = 'Checking allowance…';
    holdButton = button('Hold to reveal');
    holdButton.disabled = true;
    holdButton.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      holdButton.focus();
      startReveal(root);
    });
    holdButton.addEventListener('pointerleave', stopReveal);
    holdButton.addEventListener('keydown', event => {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (!event.repeat) startReveal(root);
    });
    holdButton.addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) stopReveal(); });
    holdButton.addEventListener('blur', stopReveal);
    panel.append(details, allowanceText, holdButton);
    if (manuallyHidden(root)) {
      const scope = posts.has(statusIdFor(root)) ? 'post' : 'media';
      const key = scope === 'post' ? statusIdFor(root) : stableMediaVerificationKey(root);
      const undo = button('Remove manual hide', async () => {
        const result = await send({ type: 'xControlRemove', scope, key }).catch(() => null);
        if (result?.ok) { applySnapshot(result); closePanel(); }
        else allowanceText.textContent = result?.error || 'Unable to remove this hide.';
      });
      undo.disabled = snapshot.locked;
      undo.title = snapshot.locked ? 'X protection is locked' : '';
      panel.appendChild(undo);
    }
    updateAllowance(root);
    allowanceTimer = setInterval(() => { if (!lease && !holding && panelRoot === root) updateAllowance(root); }, 1000);
  }
  async function startReveal(root) {
    if (holding || lease || document.visibilityState !== 'visible' || !document.hasFocus() || !root.isConnected || root.dataset.tabcloserMediaState !== 'protected') return;
    holding = true;
    const generation = ++requestGeneration;
    const page = location.href;
    const result = await send({ type: 'xControlRevealStart', postId: statusIdFor(root) }).catch(() => null);
    if (!result?.ok) {
      if (generation === requestGeneration) {
        holding = false;
        if (allowanceText) allowanceText.textContent = result?.error || 'Unable to start reveal.';
      }
      return;
    }
    if (!holding || generation !== requestGeneration || !root.isConnected || page !== location.href || document.visibilityState !== 'visible' || !document.hasFocus()) {
      send({ type: 'xControlRevealEnd', token: result.token, postId: result.postId }).catch(() => {});
      return;
    }
    lease = result;
    revealDuration = Math.min(result.durationMs, result.deadline - Date.now());
    revealStarted = performance.now();
    revealPage = page;
    closeLightbox();
    if (revealDuration <= 0) { stopReveal(); return; }
    paintReveal();
    revealTimer = setInterval(() => {
      if (!panelRoot?.isConnected || statusIdFor(panelRoot) !== lease?.postId || revealPage !== location.href || document.visibilityState !== 'visible' || !document.hasFocus() || remainingReveal() <= 0) {
        stopReveal(); return;
      }
      if (allowanceText) allowanceText.textContent = 'Visible for ' + seconds(remainingReveal()) + 's more';
    }, 40);
  }
  function remainingReveal() {
    return lease ? Math.max(0, Math.min(lease.deadline - Date.now(), revealDuration - (performance.now() - revealStarted))) : 0;
  }
  function mark(element, attribute) {
    if (!element || element.hasAttribute(attribute)) return;
    element.style.setProperty('--tabcloser-peek-ms', remainingReveal() + 'ms');
    element.setAttribute(attribute, '');
    marked.add(element);
  }
  function paintReveal() {
    if (!lease || remainingReveal() <= 0) return;
    document.querySelectorAll('[data-tabcloser-media-state="protected"]').forEach(root => {
      if (statusIdFor(root) !== lease.postId) return;
      mark(root, 'data-tabcloser-revealed');
      mark(overlayFor(root), 'data-tabcloser-overlay-revealed');
      for (const player of mediaPlayersWithin(root)) blockMediaPlayback(player);
    });
    document.querySelectorAll('.tabcloser-hidden-text, .tabcloser-quote').forEach(node => {
      if (statusIdFor(node) === lease.postId) mark(node, node.classList.contains('tabcloser-quote') ? 'data-tabcloser-quote-revealed' : 'data-tabcloser-text-revealed');
    });
  }
  function stopReveal() {
    holding = false; requestGeneration += 1;
    clearInterval(revealTimer); revealTimer = null;
    for (const node of marked) {
      for (const name of ['data-tabcloser-revealed', 'data-tabcloser-overlay-revealed', 'data-tabcloser-text-revealed', 'data-tabcloser-quote-revealed']) node.removeAttribute(name);
      node.style.removeProperty('--tabcloser-peek-ms');
    }
    marked.clear();
    const previous = lease; lease = null;
    if (previous) send({ type: 'xControlRevealEnd', token: previous.token, postId: previous.postId })
      .catch(() => {}).finally(() => { if (panelRoot) updateAllowance(panelRoot); });
  }
  function refresh() {
    refreshTimer = null;
    for (const root of [...manualRoots]) {
      if (!root.isConnected || !manuallyHidden(root)) {
        manualRoots.delete(root);
        if (root.isConnected) {
          delete root.dataset.tabcloserManualPost;
          setRootState(root, 'safe', 'manual-removed');
          delete root.dataset.tabcloserMediaState;
          delete root.dataset.tabcloserMediaReason;
          TabCloserXCoordinator.invalidate(root);
          discoverWithin(root);
        }
      }
    }
    if (posts.size || media.size) {
      const roots = new Set(candidateRootsWithin(document));
      for (const layer of document.querySelectorAll('article, article div[role="link"]')) {
        if (posts.has(statusIdFor(layer))) { layer.dataset.tabcloserManualPost = ''; roots.add(layer); }
      }
      for (const root of roots) {
        if (!manuallyHidden(root)) continue;
        manualRoots.add(root);
        if (root.dataset.tabcloserMediaReason !== 'manual' || !overlayFor(root)) setRootState(root, 'protected', 'manual');
      }
    }
    document.querySelectorAll('[data-tabcloser-media-state="protected"]').forEach(root => decorate(root, 'protected'));
    if (lease) {
      if (!panelRoot?.isConnected || revealPage !== location.href) stopReveal();
      else paintReveal();
    }
  }
  function applySnapshot(next) {
    stopReveal();
    if (panelRoot) closePanel();
    snapshot = next;
    posts = new Set(next.posts || []); media = new Set(next.media || []);
    refresh();
  }
  document.addEventListener('contextmenu', event => {
    contextTarget = event.target instanceof Element ? event.target : null;
  }, true);
  document.addEventListener('pointerup', stopReveal, true);
  document.addEventListener('pointercancel', stopReveal, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') stopReveal(); });
  window.addEventListener('blur', stopReveal);
  window.addEventListener('pagehide', stopReveal);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && panel) { event.preventDefault(); closePanel(); } }, true);
  browser.runtime.onMessage.addListener(message => {
    if (message?.type === 'xControlsChanged') applySnapshot(message.snapshot);
    if (message?.type === 'xManualHideSelection') {
      const target = contextTarget;
      contextTarget = null;
      if (!target?.isConnected) { messagePanel('Right-click a post or its media first.'); return; }
      const root = mediaRootFor(target);
      const key = message.scope === 'post' ? statusIdFor(target) : root && stableMediaVerificationKey(root);
      if (!key || (message.scope === 'post' && !target.closest('article') && !root)) {
        messagePanel('Choose a post, image, or video with a stable X link. Avatars and profile banners are not supported by manual hiding yet.'); return;
      }
      send({ type: 'xControlHide', scope: message.scope, key }).then(result => {
        if (result?.ok) { applySnapshot(result); messagePanel('Saved. This ' + (message.scope === 'post' ? 'post' : 'image or video') + ' will stay hidden. Manage manual hides in TabCloser settings.'); }
        else messagePanel(result?.error || 'Unable to save the manual hide.');
      }).catch(() => messagePanel('Unable to save the manual hide.'));
    }
  });
  new MutationObserver(mutations => {
    if (!posts.size && !media.size && !lease) return;
    if (!mutations.some(mutation => !extensionOwnedElement(mutation.target))) return;
    if (lease && (!panelRoot?.isConnected || statusIdFor(panelRoot) !== lease.postId || revealPage !== location.href)) stopReveal();
    if (refreshTimer == null) refreshTimer = setTimeout(refresh, 50);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'href'] });
  globalThis.TabCloserXInteractions = { manuallyHidden, decorate, refresh, stopReveal };
  send({ type: 'xControlGet' }).then(result => { if (result?.ok) applySnapshot(result); else refresh(); }).catch(() => refresh());
})();
