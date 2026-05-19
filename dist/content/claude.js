// Relay Chrome Extension - Claude Content Script
// Runs at document_idle on claude.ai

/**
 * Safe wrapper for chrome.runtime.sendMessage that catches
 * "Could not establish connection" errors when the service worker is inactive.
 */
function safeSendMessage(message, callback) {
  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        // Service worker not available — silently ignore
        return;
      }
      if (callback) callback(response);
    });
  } catch (e) {
    // Extension context invalidated — silently ignore
  }
}

// --- SSE Stream Interception ---
(function() {
  'use strict';

  let sseDisabled = false; // Flag to disable SSE on parse failure

  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);

    // Only intercept streaming responses from Claude's API
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const contentType = response.headers.get('content-type') || '';

    if (!sseDisabled && url.includes('/api/') && contentType.includes('text/event-stream')) {
      try {
        // Clone the response to read the stream without affecting the original
        const clone = response.clone();
        // Process the cloned stream in the background (don't await — non-blocking)
        processSSEStream(clone.body).catch(() => {
          // On any stream processing failure, disable SSE and fall back to DOM
          sseDisabled = true;
        });
      } catch (e) {
        sseDisabled = true;
      }
    }

    // Always return the original unmodified response
    return response;
  };

  async function processSSEStream(body) {
    if (!body) return;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ') && currentEvent === 'message_limit') {
            const dataStr = line.slice(6).trim();
            try {
              const data = JSON.parse(dataStr);
              const remaining = data.remaining;

              if (remaining === 0) {
                safeSendMessage({ type: 'LIMIT_DETECTED', platform: 'claude' });
              } else if (remaining > 0) {
                safeSendMessage({ type: 'WARNING_DETECTED', platform: 'claude', remaining });
              }
            } catch (parseErr) {
              // Parse failure on a single event — disable SSE, fall back to DOM
              sseDisabled = true;
              reader.cancel();
              return;
            }
            currentEvent = '';
          } else if (line === '') {
            currentEvent = '';
          }
        }
      }
    } catch (e) {
      // Stream read failure — disable SSE
      sseDisabled = true;
    }
  }
})();

// --- MutationObserver for DOM-based limit detection (Task 18) ---
(function() {
  'use strict';

  let selectors = null;
  const sentMessages = new Set(); // Track sent messages to prevent duplicates

  // Listen for SELECTORS_READY from service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SELECTORS_READY') {
      try {
        selectors = message.selectors?.platforms?.claude || null;
        if (selectors && document.body) {
          startObserver();
        }
      } catch (e) {
        console.error('[Relay] Failed to parse selectors:', e);
        selectors = null;
      }
    }
  });

  // Also proactively load selectors from storage (in case broadcast was missed)
  try {
    chrome.storage.local.get(['relay_selectors'], (data) => {
      if (chrome.runtime.lastError) return;
      if (!selectors && data.relay_selectors) {
        selectors = data.relay_selectors?.platforms?.claude || null;
        if (selectors && document.body) {
          startObserver();
        }
      }
    });
  } catch (e) {
    // Storage not available — will rely on broadcast
  }

  // Wait for body if selectors arrive before body is available
  function waitForBody() {
    if (document.body) {
      return;
    }
    const bodyObserver = new MutationObserver(() => {
      if (document.body) {
        bodyObserver.disconnect();
        if (selectors) startObserver();
      }
    });
    bodyObserver.observe(document.documentElement, { childList: true });
  }
  waitForBody();

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Check newly added nodes
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          checkNode(node);
        }
        // Also check the target element itself for text/attribute changes
        if (mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE) {
          checkNode(mutation.target);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });

    // Initial scan: check existing DOM for limit banners already present
    scanExistingDOM();
  }

  function scanExistingDOM() {
    if (!selectors || !selectors.limit_triggers) return;
    // Scan all elements on the page for existing limit text
    const allElements = document.body.querySelectorAll('div, span, p, button');
    for (const el of allElements) {
      checkNode(el);
    }
  }

  // Also run a periodic check every 3 seconds for the first 30 seconds
  // This catches banners that appear via framework state changes (not DOM mutations)
  let periodicCheckCount = 0;
  const periodicCheck = setInterval(() => {
    periodicCheckCount++;
    if (periodicCheckCount > 10) {
      clearInterval(periodicCheck);
      return;
    }
    if (selectors) scanExistingDOM();
  }, 3000);

  function checkNode(node) {
    if (!selectors) return;

    // Check limit_triggers
    if (selectors.limit_triggers) {
      for (const trigger of selectors.limit_triggers) {
        // Skip sse_event triggers — those are handled by the SSE interceptor
        if (trigger.type === 'sse_event') continue;
        if (matchesTrigger(node, trigger)) {
          const key = `limit_${JSON.stringify(trigger)}`;
          if (!sentMessages.has(key)) {
            sentMessages.add(key);
            const resetTime = extractResetTime(node);
            safeSendMessage({ type: 'LIMIT_DETECTED', platform: 'claude', resetTime }, (resp) => {
              if (resp && resp.success) {
                window.__relayShowBatonPass && window.__relayShowBatonPass();
              }
            });
          }
        }
      }
    }

    // Check warning_triggers
    if (selectors.warning_triggers) {
      for (const trigger of selectors.warning_triggers) {
        if (trigger.type === 'sse_event') continue;
        if (matchesTrigger(node, trigger)) {
          const key = `warning_${JSON.stringify(trigger)}`;
          if (!sentMessages.has(key)) {
            sentMessages.add(key);
            safeSendMessage({ type: 'WARNING_DETECTED', platform: 'claude' });
          }
        }
      }
    }
  }

  /**
   * Extract reset time from banner text like "until 3:00 AM".
   * Returns a timestamp (ms) or null if not found.
   */
  function extractResetTime(node) {
    const searchText = (node.textContent || '') + ' ' + (node.parentElement?.textContent || '') + ' ' + (document.body?.textContent?.slice(-2000) || '');
    const timeMatch = searchText.match(/(?:until)\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!timeMatch) return null;

    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const period = timeMatch[3].toUpperCase();

    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;

    const now = new Date();
    const resetDate = new Date(now);
    resetDate.setHours(hours, minutes, 0, 0);

    if (resetDate.getTime() <= now.getTime()) {
      resetDate.setDate(resetDate.getDate() + 1);
    }

    return resetDate.getTime();
  }

  function matchesTrigger(node, trigger) {
    switch (trigger.type) {
      case 'data-testid':
        return node.matches?.(`[data-testid="${trigger.value}"]`) ||
               node.querySelector?.(`[data-testid="${trigger.value}"]`) !== null;
      case 'text_contains': {
        const elements = trigger.selector
          ? [node, ...node.querySelectorAll(trigger.selector)]
          : [node];
        return elements.some(el =>
          el.textContent?.toLowerCase().includes(trigger.value.toLowerCase())
        );
      }
      case 'attribute':
        return node.matches?.(trigger.selector) ||
               node.querySelector?.(trigger.selector) !== null;
      default:
        return false;
    }
  }
})();

// --- Baton Pass Floating Card UI (Task 19) ---
(function() {
  'use strict';

  let cardShown = false;
  let timerInterval = null;

  /**
   * Format milliseconds remaining into MM:SS string.
   */
  function formatTimer(ms) {
    if (ms <= 0) return '00:00';
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  /**
   * Show the Baton Pass floating card.
   * Checks relay_usage to determine if both platforms are in cooldown.
   * If only Claude is in cooldown → show CTA button to continue in ChatGPT.
   * If both are in cooldown → show both reset timers with 1-second refresh.
   */
  function showBatonPassCard() {
    // Prevent showing multiple cards
    if (cardShown) return;
    cardShown = true;

    chrome.storage.local.get(['relay_usage'], (data) => {
      const usage = data.relay_usage || {};
      const chatgptStatus = usage.chatgpt?.status;
      const claudeStatus = usage.claude?.status;
      const bothCooldown = chatgptStatus === 'cooldown' && claudeStatus === 'cooldown';

      // Create the card container
      const card = document.createElement('div');
      card.id = 'relay-baton-pass-card';

      // Inline styles for the card
      card.style.cssText = [
        'position: fixed',
        'bottom: 20px',
        'right: 20px',
        'z-index: 999999',
        'max-width: 360px',
        'max-height: 280px',
        'background: #ffffff',
        'border-radius: 12px',
        'box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15)',
        'padding: 16px 20px',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'font-size: 14px',
        'color: #1a1a1a',
        'animation: relaySlideIn 300ms ease-out forwards',
        'opacity: 0',
        'transform: translateX(100%)',
        'box-sizing: border-box',
        'overflow: hidden'
      ].join('; ');

      // Inject keyframes for slide-in animation
      const styleEl = document.createElement('style');
      styleEl.textContent = `
        @keyframes relaySlideIn {
          from {
            opacity: 0;
            transform: translateX(100%);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `;
      document.head.appendChild(styleEl);

      // First-click-wins flag
      let handled = false;

      // Build card content
      const header = document.createElement('div');
      header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;';

      const title = document.createElement('span');
      title.textContent = 'Limit reached on Claude';
      title.style.cssText = 'font-weight: 600; font-size: 14px; color: #1a1a1a;';

      // Dismiss button
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = '\u2715';
      dismissBtn.setAttribute('aria-label', 'Dismiss');
      dismissBtn.style.cssText = [
        'background: none',
        'border: none',
        'font-size: 18px',
        'cursor: pointer',
        'color: #666',
        'padding: 0 0 0 8px',
        'line-height: 1'
      ].join('; ');

      dismissBtn.addEventListener('click', () => {
        if (handled) return;
        handled = true;
        removeCard();
      });

      header.appendChild(title);
      header.appendChild(dismissBtn);
      card.appendChild(header);

      if (bothCooldown) {
        // Both platforms in cooldown — show both reset timers
        const timersContainer = document.createElement('div');
        timersContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';

        const claudeTimer = document.createElement('div');
        claudeTimer.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
        const claudeLabel = document.createElement('span');
        claudeLabel.textContent = 'Claude resets in:';
        claudeLabel.style.cssText = 'color: #555; font-size: 13px;';
        const claudeTime = document.createElement('span');
        claudeTime.id = 'relay-timer-claude';
        claudeTime.style.cssText = 'font-weight: 600; font-size: 13px; color: #e53e3e; font-variant-numeric: tabular-nums;';
        claudeTimer.appendChild(claudeLabel);
        claudeTimer.appendChild(claudeTime);

        const chatgptTimer = document.createElement('div');
        chatgptTimer.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
        const chatgptLabel = document.createElement('span');
        chatgptLabel.textContent = 'ChatGPT resets in:';
        chatgptLabel.style.cssText = 'color: #555; font-size: 13px;';
        const chatgptTime = document.createElement('span');
        chatgptTime.id = 'relay-timer-chatgpt';
        chatgptTime.style.cssText = 'font-weight: 600; font-size: 13px; color: #e53e3e; font-variant-numeric: tabular-nums;';
        chatgptTimer.appendChild(chatgptLabel);
        chatgptTimer.appendChild(chatgptTime);

        timersContainer.appendChild(claudeTimer);
        timersContainer.appendChild(chatgptTimer);
        card.appendChild(timersContainer);

        // Update timers every 1 second
        function updateTimers() {
          const now = Date.now();
          const chatgptReset = usage.chatgpt?.estimatedResetAt;
          const claudeReset = usage.claude?.estimatedResetAt;

          const claudeEl = document.getElementById('relay-timer-claude');
          const chatgptEl = document.getElementById('relay-timer-chatgpt');

          if (claudeEl) {
            claudeEl.textContent = claudeReset ? formatTimer(claudeReset - now) : '--:--';
          }
          if (chatgptEl) {
            chatgptEl.textContent = chatgptReset ? formatTimer(chatgptReset - now) : '--:--';
          }
        }

        updateTimers();
        timerInterval = setInterval(updateTimers, 1000);
      } else {
        // Show all alternative platforms (excluding the current one: Claude)
        const platforms = [
          { id: 'chatgpt', name: 'ChatGPT', color: '#10a37f', hoverColor: '#0d8c6d' },
          { id: 'gemini', name: 'Gemini', color: '#1a73e8', hoverColor: '#1557b0' },
          { id: 'grok', name: 'Grok', color: '#1d1d1f', hoverColor: '#333' }
        ];

        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

        for (const plat of platforms) {
          const ctaBtn = document.createElement('button');
          ctaBtn.textContent = `Continue in ${plat.name} \u2192`;
          ctaBtn.setAttribute('aria-label', `Continue conversation in ${plat.name}`);
          ctaBtn.style.cssText = [
            'display: block',
            'width: 100%',
            'padding: 8px 14px',
            `background: ${plat.color}`,
            'color: #ffffff',
            'border: none',
            'border-radius: 8px',
            'font-size: 13px',
            'font-weight: 600',
            'cursor: pointer',
            'transition: background 150ms ease'
          ].join('; ');

          ctaBtn.addEventListener('mouseenter', () => { ctaBtn.style.background = plat.hoverColor; });
          ctaBtn.addEventListener('mouseleave', () => { ctaBtn.style.background = plat.color; });

          ctaBtn.addEventListener('click', () => {
            if (handled) return;
            handled = true;

            // Show loading state
            ctaBtn.textContent = '';
            ctaBtn.style.pointerEvents = 'none';
            ctaBtn.style.opacity = '0.8';

            const spinner = document.createElement('span');
            spinner.style.cssText = 'display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: relaySpin 0.6s linear infinite; margin-right: 8px; vertical-align: middle;';
            ctaBtn.appendChild(spinner);

            const loadingText = document.createElement('span');
            loadingText.textContent = 'Preparing handoff...';
            loadingText.style.verticalAlign = 'middle';
            ctaBtn.appendChild(loadingText);

            if (!document.getElementById('relay-spin-style')) {
              const spinStyle = document.createElement('style');
              spinStyle.id = 'relay-spin-style';
              spinStyle.textContent = '@keyframes relaySpin { to { transform: rotate(360deg); } }';
              document.head.appendChild(spinStyle);
            }

            // Invoke extractor and send to service worker
            const extractorFn = window.__relayExtractContextFn;
            try {
              if (extractorFn) {
                chrome.storage.local.get(['relay_selectors'], (data) => {
                  if (chrome.runtime.lastError) { removeCard(); return; }
                  const platformSelectors = data.relay_selectors?.platforms?.claude || null;
                  const raw = extractorFn('claude', platformSelectors);

                  // Truncate large fields to avoid Chrome message size limits
                  const context = {
                    platform: raw.platform,
                    goal: (raw.goal || '').slice(0, 2000),
                    codeBlocks: (raw.codeBlocks || []).slice(-2).map(c => c.slice(0, 500)),
                    keyOutputs: (raw.keyOutputs || []).slice(0, 3).map(k => k.slice(0, 1000)),
                    lastExchanges: (raw.lastExchanges || []).slice(-10).map(e => ({ user: (e.user || '').slice(0, 500), assistant: (e.assistant || '').slice(0, 1000) })),
                    errorMessages: (raw.errorMessages || []).slice(0, 5),
                    sessionType: raw.sessionType,
                    totalMessages: raw.totalMessages,
                    extractedAt: raw.extractedAt
                  };

                  safeSendMessage({ type: 'CONTEXT_EXTRACTED', context }, () => {
                    safeSendMessage({ type: 'BATON_PASS_REQUESTED', platform: 'claude', targetPlatform: plat.id });
                    removeCard();
                  });
                });
              } else {
                safeSendMessage({ type: 'BATON_PASS_REQUESTED', platform: 'claude', targetPlatform: plat.id });
                removeCard();
              }
            } catch (e) {
              removeCard();
            }
          });

          btnContainer.appendChild(ctaBtn);
        }

        card.appendChild(btnContainer);
      }

      // Append card to body
      if (document.body) {
        document.body.appendChild(card);
      } else {
        const bodyWait = new MutationObserver(() => {
          if (document.body) {
            bodyWait.disconnect();
            document.body.appendChild(card);
          }
        });
        bodyWait.observe(document.documentElement, { childList: true });
      }
    });
  }

  /**
   * Remove the floating card from the DOM and clean up timers.
   */
  function removeCard() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    const card = document.getElementById('relay-baton-pass-card');
    if (card) {
      card.remove();
    }
    // Don't reset cardShown — card should only appear once per session
  }

  // Expose showBatonPassCard globally so it can be called from the SSE interceptor and MutationObserver
  window.__relayShowBatonPass = showBatonPassCard;
})();
