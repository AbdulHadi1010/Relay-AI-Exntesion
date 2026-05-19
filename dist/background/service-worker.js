/**
 * Relay Chrome Extension - Service Worker
 *
 * Central orchestrator for the Relay extension. Handles:
 * - Usage tracking initialization (relay_usage)
 * - Remote selector fetching and caching
 * - Message routing from content scripts
 * - Tab management for Baton Pass
 * - Alarm-based cooldown reset timers
 */

/**
 * Module-level flag to prevent duplicate routing operations.
 * While a Baton Pass routing is in progress, subsequent BATON_PASS_REQUESTED
 * messages are ignored. (Requirement 9, AC7)
 */
let routingInProgress = false;

/**
 * On first install, initialize the relay_usage record in chrome.storage.local
 * with both platforms set to unknown status and zeroed counters.
 * (Requirement 10, AC9)
 */
chrome.runtime.onInstalled.addListener((details) => {
  const now = Date.now();

  const initialUsage = {
    chatgpt: {
      messagesThisWindow: 0,
      estimatedLimit: 15,
      limitHitAt: null,
      estimatedResetAt: null,
      lastUpdated: now,
      status: 'available'
    },
    claude: {
      messagesThisWindow: 0,
      estimatedLimit: 25,
      limitHitAt: null,
      estimatedResetAt: null,
      lastUpdated: now,
      status: 'available'
    }
  };

  if (details.reason === 'install') {
    chrome.storage.local.set({ relay_usage: initialUsage });
  } else if (details.reason === 'update') {
    // Patch in defaults for existing installs
    chrome.storage.local.get(['relay_usage'], (data) => {
      if (!data.relay_usage) {
        chrome.storage.local.set({ relay_usage: initialUsage });
      } else {
        const usage = data.relay_usage;
        let changed = false;
        if (usage.chatgpt && usage.chatgpt.estimatedLimit === null) {
          usage.chatgpt.estimatedLimit = 15;
          usage.chatgpt.status = 'available';
          changed = true;
        }
        if (usage.claude && usage.claude.estimatedLimit === null) {
          usage.claude.estimatedLimit = 25;
          usage.claude.status = 'available';
          changed = true;
        }
        if (changed) chrome.storage.local.set({ relay_usage: usage });
      }
    });
  }
});

/**
 * Fetch remote selectors on service worker start.
 * Reads remote_url from bundled config/selectors.json, fetches the remote file,
 * validates it as JSON with a `platforms` field, and stores in chrome.storage.local
 * under `relay_selectors`. Falls back to bundled local file on any failure.
 * (Requirement 4)
 */
(async function fetchAndStoreSelectors() {
  let selectors;

  try {
    // Load the bundled selectors.json from the extension package
    const bundledUrl = chrome.runtime.getURL('config/selectors.json');
    const bundledResponse = await fetch(bundledUrl);
    const bundledSelectors = await bundledResponse.json();

    const remoteUrl = bundledSelectors.remote_url;

    // If remote_url is missing or empty, use bundled local file (Req 4 AC6)
    if (!remoteUrl) {
      selectors = bundledSelectors;
    } else {
      try {
        // Fetch remote selectors with 5-second timeout (Req 4 AC4, AC7)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const remoteResponse = await fetch(remoteUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        const remoteText = await remoteResponse.text();
        const remoteSelectors = JSON.parse(remoteText);

        // Validate the remote content has a `platforms` field
        if (remoteSelectors && typeof remoteSelectors.platforms === 'object') {
          selectors = remoteSelectors;
        } else {
          // Invalid structure, fall back to bundled (Req 4 AC5)
          selectors = bundledSelectors;
        }
      } catch (e) {
        // Remote fetch failed, timed out, or invalid JSON — fall back to bundled (Req 4 AC3, AC5, AC7)
        selectors = bundledSelectors;
      }
    }
  } catch (e) {
    // Bundled file could not be loaded — this should not happen in a properly packaged extension
    // Use a minimal fallback
    selectors = { platforms: {} };
  }

  // Store the active selectors in chrome.storage.local (Req 4 AC2)
  await chrome.storage.local.set({ relay_selectors: selectors });

  // Broadcast SELECTORS_READY to any connected content scripts on supported platforms.
  // Content scripts will also request selectors on load via storage, so this broadcast
  // is best-effort only — failures are expected and harmless.
  try {
    const chatgptTabs = await chrome.tabs.query({ url: '*://chatgpt.com/*' });
    const claudeTabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
    const relevantTabs = [...chatgptTabs, ...claudeTabs];
    for (const tab of relevantTabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'SELECTORS_READY', selectors })
        .then(() => {})
        .catch(() => {}); // Silently ignore — tab may not have listener ready
    }
  } catch (e) {
    // tabs.query may fail — ignore
  }
})();

/**
 * Message listener for LIMIT_DETECTED from content scripts.
 * Updates the platform's relay_usage record to cooldown status,
 * calculates the reset time, and creates a chrome.alarms entry.
 * (Requirement 10, AC5)
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LIMIT_DETECTED') {
    const { platform, resetTime } = message;

    (async () => {
      try {
        // Read current selectors and usage from storage
        const data = await chrome.storage.local.get(['relay_selectors', 'relay_usage']);
        const selectors = data.relay_selectors || { platforms: {} };
        const usage = data.relay_usage || {};

        const now = Date.now();
        const currentRecord = usage[platform] || {};

        // If already in cooldown with a valid estimatedResetAt that's still in the future,
        // don't overwrite it (prevents timer reset on page refresh)
        if (currentRecord.status === 'cooldown' && currentRecord.estimatedResetAt && currentRecord.estimatedResetAt > now) {
          // Update with better resetTime if provided by banner parsing
          if (resetTime && typeof resetTime === 'number' && resetTime > now) {
            currentRecord.estimatedResetAt = resetTime;
            currentRecord.lastUpdated = now;
            usage[platform] = currentRecord;
            await chrome.storage.local.set({ relay_usage: usage });
            await chrome.alarms.create(`reset_${platform}`, { when: resetTime });
          }
          sendResponse({ success: true, platform, status: 'cooldown' });
          return;
        }

        // Use resetTime from banner if available, otherwise calculate from reset_window_hours
        let estimatedResetAt;
        if (resetTime && typeof resetTime === 'number' && resetTime > now) {
          estimatedResetAt = resetTime;
        } else {
          const platformSelectors = selectors.platforms?.[platform] || {};
          const resetWindowHours = platformSelectors.reset_window_hours || 3;
          estimatedResetAt = now + (resetWindowHours * 3600000);
        }

        // Update the platform's usage record
        usage[platform] = {
          ...usage[platform],
          status: 'cooldown',
          limitHitAt: now,
          estimatedResetAt: estimatedResetAt,
          lastUpdated: now
        };

        // Store updated relay_usage back to chrome.storage.local
        await chrome.storage.local.set({ relay_usage: usage });

        // Create a chrome.alarms entry for the reset time
        await chrome.alarms.create(`reset_${platform}`, { when: estimatedResetAt });

        sendResponse({ success: true, platform, status: 'cooldown' });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();

    // Return true to indicate we will send a response asynchronously
    return true;
  } else if (message.type === 'WARNING_DETECTED') {
    const { platform, remaining } = message;

    (async () => {
      try {
        // Read current usage from storage
        const data = await chrome.storage.local.get(['relay_usage']);
        const usage = data.relay_usage || {};

        const now = Date.now();
        const platformRecord = usage[platform] || {
          messagesThisWindow: 0,
          estimatedLimit: null,
          limitHitAt: null,
          estimatedResetAt: null,
          lastUpdated: now,
          status: 'unknown'
        };

        // If remaining count is provided, update estimatedLimit
        if (remaining !== undefined && remaining !== null) {
          platformRecord.estimatedLimit = platformRecord.messagesThisWindow + remaining;
        }

        // Update lastUpdated timestamp
        platformRecord.lastUpdated = now;

        // Evaluate 80% warning threshold only if:
        // 1. estimatedLimit is known (not null) — Req 10 AC8
        // 2. status is not already 'cooldown' — Req 10 AC5/AC7
        if (platformRecord.estimatedLimit !== null && platformRecord.status !== 'cooldown') {
          if (platformRecord.messagesThisWindow > 0.8 * platformRecord.estimatedLimit) {
            platformRecord.status = 'warning';
          }
        }

        // Store updated platform record
        usage[platform] = platformRecord;
        await chrome.storage.local.set({ relay_usage: usage });

        sendResponse({ success: true, platform, status: platformRecord.status });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();

    // Return true to indicate we will send a response asynchronously
    return true;
  } else if (message.type === 'CONTEXT_EXTRACTED') {
    // Store the Session_Context in relay_pending_handoff, overwriting any existing value.
    // If a Groq API key is configured, enhance the context with AI summarization first.
    // (Requirement 15, AC2, AC7)
    (async () => {
      try {
        let context = message.context;

        // Always try Groq-powered summarization via Cloudflare Worker
        try {
          if (context && context.totalMessages > 0) {
            const enhanced = await summarizeWithGroq(context, null);
            if (enhanced) {
              context = { ...context, ...enhanced };
            }
          }
        } catch (e) {
          // Groq failed — fall back to rule-based context silently
        }

        await chrome.storage.local.set({ relay_pending_handoff: context });
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();

    // Return true to indicate we will send a response asynchronously
    return true;
  } else if (message.type === 'RELAY_FULL_HANDOFF') {
    // Full handoff flow triggered from popup: extract → summarize → store → open → inject
    const { sourceTabId, sourcePlatform, targetPlatform } = message;

    (async () => {
      try {
        // Badge: extracting
        chrome.action.setBadgeText({ text: '...' });
        chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });

        // Step 1: Extract context from source tab
        let context = null;
        try {
          const response = await chrome.tabs.sendMessage(sourceTabId, {
            type: 'RELAY_EXTRACT_CONTEXT',
            platform: sourcePlatform
          });
          if (response && response.totalMessages > 0) {
            context = response;
          }
        } catch (e) {
          // Content script might not be ready — continue without context
        }

        // Badge: summarizing
        chrome.action.setBadgeText({ text: 'AI' });

        // Step 2: Groq summarization (if we have context)
        if (context && context.totalMessages > 0) {
          try {
            // Build structured text for Groq:
            // - First user message (original goal)
            // - All exchanges if short, or last 8-10 if long
            // - Key outputs
            const parts = [];
            
            // First message / goal
            if (context.goal) {
              const goalText = context.goal;
              const firstUserMsg = goalText.includes('You said:') 
                ? goalText.split('You said:')[1]?.split(/Claude responded:|May \d|$/).shift()?.trim() || goalText.slice(0, 800)
                : goalText.slice(0, 800);
              parts.push(`FIRST USER MESSAGE:\n${firstUserMsg}`);
            }

            // Exchanges — send all if conversation is short, last 8-10 if long
            if (context.lastExchanges && context.lastExchanges.length > 0) {
              parts.push('CONVERSATION:');
              for (const ex of context.lastExchanges) {
                // Give more space to each exchange for longer conversations
                const userLen = context.lastExchanges.length <= 4 ? 800 : 400;
                const aiLen = context.lastExchanges.length <= 4 ? 2000 : 1000;
                parts.push(`USER: ${(ex.user || '').slice(0, userLen)}`);
                parts.push(`ASSISTANT: ${(ex.assistant || '').slice(0, aiLen)}`);
              }
            }

            // Key outputs
            if (context.keyOutputs && context.keyOutputs.length > 0) {
              parts.push(`KEY CONTENT PRODUCED:\n${context.keyOutputs.map(k => k.slice(0, 800)).join('\n---\n')}`);
            }

            const chatText = parts.join('\n\n');
            
            // Send up to 16K chars (Groq's llama-3.1-8b handles 128K context)
            if (chatText.trim().length > 50) {
              const resp = await fetch('https://relay-groq-proxy.stryxon.workers.dev/summarize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: chatText.slice(0, 16000), tier: 'free' })
              });
              const data = await resp.json();
              if (data.summary) {
                const jsonMatch = data.summary.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const summary = JSON.parse(jsonMatch[0]);
                  if (summary.goal) context.goal = summary.goal;
                  if (summary.progress) {
                    context.keyOutputs = Array.isArray(summary.progress) ? summary.progress : [summary.progress];
                  }
                  if (summary.blocker) context.blocker = summary.blocker;
                  if (summary.sessionType) context.sessionType = summary.sessionType;
                }
              }
            }
          } catch (e) {
            // Groq failed — use raw context
          }
        }

        // Step 3: Store context
        if (context) {
          await chrome.storage.local.set({ relay_pending_handoff: context });
        }

        // Badge: opening
        chrome.action.setBadgeText({ text: '→' });

        // Step 4: Open target platform
        const platformUrls = {
          claude: 'https://claude.ai/new',
          chatgpt: 'https://chatgpt.com/?model=auto',
          gemini: 'https://gemini.google.com/app',
          grok: 'https://grok.com'
        };
        const targetUrl = platformUrls[targetPlatform] || platformUrls.chatgpt;
        const newTab = await chrome.tabs.create({ url: targetUrl });

        // Step 5: Wait for tab to load, then inject
        const injectTimeout = setTimeout(() => {
          chrome.action.setBadgeText({ text: '!' });
          setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
        }, 30000);

        chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
          if (tabId === newTab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(injectTimeout);

            // Badge: injecting
            chrome.action.setBadgeText({ text: '✓' });

            if (context) {
              chrome.scripting.executeScript({
                target: { tabId: newTab.id },
                files: ['handoff/injector.js']
              }).then(() => {
                // Success — clear badge after 2s
                setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
              }).catch(() => {
                chrome.action.setBadgeText({ text: '!' });
                setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
              });
            } else {
              // No context — just opened the tab
              setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1000);
            }
          }
        });

        sendResponse({ success: true });
      } catch (e) {
        chrome.action.setBadgeText({ text: '!' });
        setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
        sendResponse({ success: false, error: e.message });
      }
    })();

    return true;
  } else if (message.type === 'BATON_PASS_REQUESTED') {
    // Ignore subsequent requests while a routing operation is in progress (Req 9 AC7)
    if (routingInProgress) {
      sendResponse({ success: false, error: 'Routing already in progress' });
      return true;
    }

    const { platform, targetPlatform } = message;

    // Platform routing table
    const platformUrls = {
      claude: 'https://claude.ai/new',
      chatgpt: 'https://chatgpt.com/?model=auto',
      gemini: 'https://gemini.google.com/app',
      grok: 'https://grok.com'
    };

    // Determine target: use explicit targetPlatform if provided, otherwise pick the best available
    let targetUrl;
    if (targetPlatform && platformUrls[targetPlatform]) {
      targetUrl = platformUrls[targetPlatform];
    } else {
      // Default: toggle between chatgpt and claude
      targetUrl = platform === 'chatgpt' ? platformUrls.claude : platformUrls.chatgpt;
    }

    routingInProgress = true;

    (async () => {
      try {
        // Open target URL in a new tab (Req 9 AC1, AC2)
        const newTab = await chrome.tabs.create({ url: targetUrl });

        // Set up a 30-second timeout (Req 9 AC4)
        const timeoutId = setTimeout(() => {
          routingInProgress = false;
          chrome.tabs.onUpdated.removeListener(tabUpdateListener);
          // Store TAB_LOAD_TIMEOUT error for the popup (Req 9 AC4)
          chrome.storage.local.set({
            relay_last_error: {
              code: 'TAB_LOAD_TIMEOUT',
              message: 'Target tab did not finish loading within 30 seconds',
              timestamp: Date.now()
            }
          });
        }, 30000);

        // Listen for tab load complete (Req 9 AC3)
        const tabUpdateListener = (tabId, changeInfo) => {
          if (tabId === newTab.id && changeInfo.status === 'complete') {
            clearTimeout(timeoutId);
            chrome.tabs.onUpdated.removeListener(tabUpdateListener);
            routingInProgress = false;
            // Execute handoff/injector.js in the new tab (Req 9 AC3, AC5)
            chrome.scripting.executeScript({
              target: { tabId: newTab.id },
              files: ['handoff/injector.js']
            }).catch((err) => {
              // Store SCRIPT_INJECTION_FAILED error for the popup (Req 9 AC6)
              chrome.storage.local.set({
                relay_last_error: {
                  code: 'SCRIPT_INJECTION_FAILED',
                  message: err.message || 'Failed to inject handoff script',
                  timestamp: Date.now()
                }
              });
              // Leave the new tab open per requirements
            });
          }
        };

        chrome.tabs.onUpdated.addListener(tabUpdateListener);

        sendResponse({ success: true, tabId: newTab.id });
      } catch (e) {
        routingInProgress = false;
        sendResponse({ success: false, error: e.message });
      }
    })();

    // Return true to indicate we will send a response asynchronously
    return true;
  }
});


/**
 * Alarm listener for cooldown reset timers.
 * When a reset alarm fires (name starts with 'reset_'), reset the platform's
 * messagesThisWindow to 0 and set status to 'available'.
 * (Requirement 10, AC6)
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('reset_')) {
    return;
  }

  const platform = alarm.name.split('reset_')[1];

  (async () => {
    try {
      const data = await chrome.storage.local.get(['relay_usage']);
      const usage = data.relay_usage || {};

      const now = Date.now();

      if (usage[platform]) {
        usage[platform] = {
          ...usage[platform],
          messagesThisWindow: 0,
          status: 'available',
          lastUpdated: now
        };

        await chrome.storage.local.set({ relay_usage: usage });
      }
    } catch (e) {
      // Silently handle errors — alarm reset should not crash the service worker
    }
  })();
});

/**
 * ChatGPT message counting via webRequest.
 * Listens for outgoing POST requests to chatgpt.com/backend-api/conversation
 * and increments messagesThisWindow for the ChatGPT platform record.
 * Also evaluates the 80% warning threshold after incrementing.
 * (Requirement 10, AC3)
 */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only count POST requests
    if (details.method !== 'POST') {
      return;
    }

    (async () => {
      try {
        const data = await chrome.storage.local.get(['relay_usage']);
        const usage = data.relay_usage || {};

        const now = Date.now();

        const chatgptRecord = usage.chatgpt || {
          messagesThisWindow: 0,
          estimatedLimit: null,
          limitHitAt: null,
          estimatedResetAt: null,
          lastUpdated: now,
          status: 'unknown'
        };

        // Increment message count
        chatgptRecord.messagesThisWindow += 1;
        chatgptRecord.lastUpdated = now;

        // Evaluate 80% warning threshold:
        // Only if estimatedLimit is known (not null) and status is not 'cooldown'
        if (chatgptRecord.estimatedLimit !== null && chatgptRecord.status !== 'cooldown') {
          if (chatgptRecord.messagesThisWindow > 0.8 * chatgptRecord.estimatedLimit) {
            chatgptRecord.status = 'warning';
          }
        }

        usage.chatgpt = chatgptRecord;
        await chrome.storage.local.set({ relay_usage: usage });
      } catch (e) {
        // Silently handle errors — message counting should not crash the service worker
      }
    })();
  },
  { urls: ['*://chatgpt.com/backend-api/conversation*'] },
  ['requestBody']
);

/**
 * Summarize conversation context using the Cloudflare Worker proxy (Groq API).
 * Returns enhanced context fields or null if summarization fails.
 * Called during CONTEXT_EXTRACTED handling.
 *
 * @param {object} context - The rule-based Session_Context
 * @param {string} _apiKey - Unused (key is in Cloudflare Worker secret)
 * @returns {object|null} Enhanced fields: { goal, keyOutputs, sessionType, blocker } or null
 */
async function summarizeWithGroq(context, _apiKey) {
  const WORKER_URL = 'https://relay-groq-proxy.stryxon.workers.dev/summarize';

  // Build a text representation of the conversation for summarization
  const conversationParts = [];

  if (context.goal) {
    conversationParts.push(`First message: ${context.goal}`);
  }

  if (context.keyOutputs && context.keyOutputs.length > 0) {
    conversationParts.push(`Key outputs:\n${context.keyOutputs.join('\n')}`);
  }

  if (context.lastExchanges && context.lastExchanges.length > 0) {
    for (const exchange of context.lastExchanges) {
      conversationParts.push(`User: ${exchange.user}`);
      conversationParts.push(`AI: ${exchange.assistant}`);
    }
  }

  if (context.codeBlocks && context.codeBlocks.length > 0) {
    conversationParts.push(`Code blocks:\n${context.codeBlocks.slice(-2).join('\n---\n')}`);
  }

  const chatText = conversationParts.join('\n\n').slice(0, 8000);

  if (!chatText.trim()) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ text: chatText, tier: 'free' })
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    const summaryText = data.summary;
    if (!summaryText) return null;

    // Parse the JSON response from Groq (via worker)
    const jsonMatch = summaryText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const summary = JSON.parse(jsonMatch[0]);

    // Return enhanced fields that override the rule-based ones
    const enhanced = {};
    if (summary.goal) enhanced.goal = summary.goal;
    if (summary.progress) {
      enhanced.keyOutputs = Array.isArray(summary.progress)
        ? summary.progress
        : [summary.progress];
    }
    if (summary.blocker) enhanced.blocker = summary.blocker;
    if (summary.sessionType && ['coding', 'writing', 'research', 'general'].includes(summary.sessionType)) {
      enhanced.sessionType = summary.sessionType;
    }

    return enhanced;
  } catch (e) {
    clearTimeout(timeoutId);
    return null; // Silently fall back to rule-based extraction
  }
}
