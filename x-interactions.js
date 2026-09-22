// User-facing controls are separate from classifier verdicts. A reveal only
// changes presentation; it never marks media safe or resumes video playback.
(() => {
  let snapshot = { posts: [], media: [], revealDailySec: 0, locked: false };
  let posts = new Set(), texts = new Set(), media = new Set();
  let contextTarget = null, panel = null, panelRoot = null, allowanceText = null, holdButton = null;
  let holding = false, requestGeneration = 0, lease = null, revealTimer = null, refreshTimer = null;
  let allowanceTimer = null;
  let revealStarted = 0, revealDuration = 0, revealPage = '';
  const marked = new Set();
  const manualRoots = new Set();
  const manualTexts = new Map();
  const send = message => browser.runtime.sendMessage(message);
  const seconds = ms => ms > 0 && ms < 100 ? '<0.1' : (Math.max(0, ms || 0) / 1000).toFixed(1);
  const textHidden = root => root?.matches?.('[data-testid="tweetText"]') && (posts.has(statusIdFor(root)) || texts.has(statusIdFor(root)));

  function manuallyHidden(root) {
    return textHidden(root) || posts.has(statusIdFor(root)) || media.has(stableMediaVerificationKey(root));
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
    if (textHidden(root)) return 'You chose to hide this post’s text. The choice is saved on this device.';
    const reason = root.dataset.tabcloserMediaReason;
    if (reason === 'manual') return 'You chose to hide this image or video. The choice is saved on this device.';
    if (reason === 'metadata') return 'X supplied a sensitive-content label or warning for this media, post, or author.';
    if (reason !== 'visual') return 'The media could not be checked (' + (reason || 'unknown error') + '). It stays covered while TabCloser retries when possible.';
    const decision = TabCloserXCoordinator.decisionFor(root);
    if (!decision) return 'The on-device model flagged this media during an earlier check in this page. Models can make mistakes.';
    let text = 'The on-device model flagged the ' + decision.source + '.';
    if (Number.isFinite(decision.adultScore)) text += ' Score ' + decision.adultScore.toFixed(3) + ', cutoff ' + decision.threshold.toFixed(2) + ' (' + decision.sensitivity + ').';
    if (decision.frames?.length) {
      if (decision.aggregate === 'strong-consensus') text += ' Lenient video protection requires two full frames scoring at least ' + (decision.threshold * 2).toFixed(2) + '.';
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
    (manualTexts.get(previousRoot) || overlayFor(previousRoot || document.documentElement))?.querySelector('button')?.focus();
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
  function renderAllowance(result, root) {
    const available = Math.floor(Math.min(result.dailyMs || 0, result.postMs || 0));
    allowanceText.textContent = result.revealDailySec <= 0
      ? 'Temporary reveals are off. Set a daily allowance in TabCloser settings.'
      : result.dailyMs < 1
        ? 'Daily allowance used up. Reveals return at local midnight.'
        : result.postMs < 1
          ? 'This post has used its three seconds today. It can be revealed again after local midnight.'
          : 'Up to ' + seconds(available) + 's available for this post · ' + seconds(result.dailyMs) + 's remaining today. Resets at local midnight.';
    holdButton.disabled = !statusIdFor(root) || result.revealDailySec <= 0 || available < 1;
  }
  async function updateAllowance(root) {
    const target = panel;
    const result = await send({ type: 'xControlGet', postId: statusIdFor(root) }).catch(() => null);
    if (target !== panel || !result?.ok || lease || holding) return;
    renderAllowance(result, root);
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
      const scope = posts.has(statusIdFor(root)) ? 'post' : textHidden(root) ? 'text' : 'media';
      const key = scope !== 'media' ? statusIdFor(root) : stableMediaVerificationKey(root);
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
    if (!holdButton || holdButton.disabled || holding || lease || document.visibilityState !== 'visible' || !document.hasFocus() || !root.isConnected || (root.dataset.tabcloserMediaState !== 'protected' && !textHidden(root))) return;
    holding = true;
    const generation = ++requestGeneration;
    const page = location.href;
    const result = await send({ type: 'xControlRevealStart', postId: statusIdFor(root) }).catch(() => null);
    if (!result?.ok) {
      if (generation === requestGeneration) {
        holding = false;
        if (allowanceText && Number.isFinite(result?.dailyMs)) renderAllowance(result, root);
        else if (allowanceText) allowanceText.textContent = result?.error || 'Unable to start reveal.';
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
    document.querySelectorAll('.tabcloser-hidden-text, .tabcloser-quote, .tabcloser-manual-text-notice').forEach(node => {
      if (statusIdFor(node) === lease.postId) mark(node, node.classList.contains('tabcloser-hidden-text') ? 'data-tabcloser-text-revealed' : 'data-tabcloser-quote-revealed');
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
    for (const [text, notice] of manualTexts) {
      if (!text.isConnected || !textHidden(text)) {
        notice.remove(); manualTexts.delete(text);
        delete text.dataset.tabcloserManualText;
        if (text.dataset.tabcloserQuoted !== 'yes') text.classList.remove('tabcloser-hidden-text');
      }
    }
    if (posts.size || texts.size) {
      for (const text of document.querySelectorAll('[data-testid="tweetText"]')) {
        if (!textHidden(text)) continue;
        text.dataset.tabcloserManualText = '';
        text.classList.add('tabcloser-hidden-text');
        if (manualTexts.get(text)?.isConnected) continue;
        const notice = document.createElement('div');
        notice.className = 'tabcloser-controls tabcloser-manual-text-notice';
        notice.append('Text hidden by you. ', button('Why hidden?', () => openPanel(text)));
        isolateControls(notice);
        text.insertAdjacentElement('afterend', notice);
        manualTexts.set(text, notice);
      }
    }
    for (const root of [...manualRoots]) {
      if (!root.isConnected || !manuallyHidden(root)) {
        manualRoots.delete(root);
        if (root.isConnected) {
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
    posts = new Set(next.posts || []); texts = new Set(next.texts || []); media = new Set(next.media || []);
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
      const key = message.scope === 'text' ? statusIdFor(target) : root && stableMediaVerificationKey(root);
      if (!key || (message.scope === 'text' && !target.closest('article'))) {
        messagePanel('Choose a post, image, or video with a stable X link. Avatars and profile banners are not supported by manual hiding yet.'); return;
      }
      send({ type: 'xControlHide', scope: message.scope, key }).then(result => {
        if (result?.ok) { applySnapshot(result); messagePanel('Saved. This ' + (message.scope === 'text' ? 'post’s text' : 'image or video') + ' will stay hidden. Manage manual hides in TabCloser settings.'); }
        else messagePanel(result?.error || 'Unable to save the manual hide.');
      }).catch(() => messagePanel('Unable to save the manual hide.'));
    }
  });
  new MutationObserver(mutations => {
    if (!posts.size && !texts.size && !media.size && !lease) return;
    if (!mutations.some(mutation => !extensionOwnedElement(mutation.target))) return;
    if (lease && (!panelRoot?.isConnected || statusIdFor(panelRoot) !== lease.postId || revealPage !== location.href)) stopReveal();
    if (refreshTimer == null) refreshTimer = setTimeout(refresh, 50);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'href'] });
  globalThis.TabCloserXInteractions = { manuallyHidden, decorate, refresh, stopReveal };
  send({ type: 'xControlGet' }).then(result => { if (result?.ok) applySnapshot(result); else refresh(); }).catch(() => refresh());
})();
