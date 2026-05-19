// Relay Chrome Extension - Context Extractor
// Shared module for rule-based conversation context extraction

/**
 * Extract conversation context from the current page DOM.
 * @param {string} platform - 'chatgpt' or 'claude'
 * @param {object} selectors - Platform-specific selectors from selectors.json
 * @returns {object} Session_Context object
 */
function extractContext(platform, selectors) {
  const context = {
    platform,
    goal: '',
    codeBlocks: [],
    keyOutputs: [],
    lastExchanges: [],
    errorMessages: [],
    sessionType: 'general',
    totalMessages: 0,
    extractedAt: new Date().toISOString()
  };

  // Try selector-based extraction first
  const selectorResult = extractWithSelectors(platform, selectors, context);
  
  // If selector-based extraction found messages, use it
  if (selectorResult.totalMessages > 0) {
    return selectorResult;
  }

  // Fallback: try common selectors for each platform
  const fallbackResult = extractWithFallbackSelectors(platform, context);
  if (fallbackResult.totalMessages > 0) {
    return fallbackResult;
  }

  // Last resort: extract raw conversation text from the page
  const rawResult = extractRawConversation(platform, context);
  return rawResult;
}

/**
 * Try extraction using the provided selectors from selectors.json
 */
function extractWithSelectors(platform, selectors, context) {
  const result = { ...context };

  if (!selectors || !selectors.message_selectors) {
    return result;
  }

  const userSelector = selectors.message_selectors.user;
  const assistantSelector = selectors.message_selectors.assistant;
  const codeBlockSelector = selectors.code_block_selectors?.[0] || 'pre code';

  const userMessages = document.querySelectorAll(userSelector);
  const assistantMessages = document.querySelectorAll(assistantSelector);

  if (userMessages.length === 0 && assistantMessages.length === 0) {
    return result;
  }

  return buildContext(result, userMessages, assistantMessages, codeBlockSelector);
}

/**
 * Try extraction using common fallback selectors for each platform
 */
function extractWithFallbackSelectors(platform, context) {
  const result = { ...context };

  // Platform-specific fallback selectors (multiple attempts)
  const fallbacks = {
    chatgpt: [
      { user: "[data-message-author-role='user']", assistant: "[data-message-author-role='assistant']" },
      { user: "[data-role='user']", assistant: "[data-role='assistant']" },
      { user: ".text-base [data-message-author-role='user']", assistant: ".text-base [data-message-author-role='assistant']" }
    ],
    claude: [
      { user: "[data-testid^='human-turn']", assistant: "[data-testid^='ai-turn']" },
      { user: ".human-turn", assistant: ".ai-turn" },
      { user: "[class*='human']", assistant: "[class*='assistant'], [class*='ai-turn']" },
      { user: "[data-is-streaming] .font-user-message, .font-user-message", assistant: "[data-is-streaming] .font-claude-message, .font-claude-message" }
    ]
  };

  const platformFallbacks = fallbacks[platform] || [...fallbacks.chatgpt, ...fallbacks.claude];

  for (const fb of platformFallbacks) {
    const userMessages = document.querySelectorAll(fb.user);
    const assistantMessages = document.querySelectorAll(fb.assistant);

    if (userMessages.length > 0 || assistantMessages.length > 0) {
      return buildContext(result, userMessages, assistantMessages, 'pre code');
    }
  }

  return result;
}

/**
 * Last resort: extract raw text from the conversation area.
 * Looks for the main content area and splits by common patterns.
 */
function extractRawConversation(platform, context) {
  const result = { ...context };

  // Find the main conversation scroll container (not sidebar, not nav)
  // Strategy: find the tallest scrollable div that contains conversation text
  let conversationEl = null;

  // Platform-specific conversation container selectors
  const platformContainers = {
    claude: [
      'div[class*="overflow-y-auto"][class*="scrollbar-gutter"]',
      'div[class*="overflow-y-auto"][class*="pt-6"][class*="flex-1"]',
      'div[class*="overflow-y-auto"][class*="flex-1"]'
    ],
    chatgpt: [
      'main div[class*="overflow-y-auto"]',
      '[role="presentation"]',
      'main'
    ]
  };

  const selectors = platformContainers[platform] || [...platformContainers.chatgpt, ...platformContainers.claude];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > 400 && el.textContent.length > 200) {
        conversationEl = el;
        break;
      }
    } catch (e) {
      continue;
    }
  }

  // Fallback: find the tallest scrollable container (likely the conversation)
  if (!conversationEl) {
    const scrollables = document.querySelectorAll('div[class*="overflow"]');
    let maxScrollHeight = 0;
    for (const el of scrollables) {
      if (el.scrollHeight > maxScrollHeight && el.scrollHeight > 500 && el.textContent.length > 200) {
        // Skip elements that look like sidebars (narrow width)
        const rect = el.getBoundingClientRect();
        if (rect.width > 400) {
          maxScrollHeight = el.scrollHeight;
          conversationEl = el;
        }
      }
    }
  }

  if (!conversationEl) {
    conversationEl = document.querySelector('main') || document.body;
  }

  // Get the raw text from the conversation container only
  const rawText = conversationEl.textContent || '';
  
  if (rawText.length < 50) return result;

  // Clean up the text: remove excessive whitespace and UI artifacts
  const cleanedText = rawText
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\t+/g, ' ')
    .trim();

  // Try to parse Claude's "You said:" / "Claude responded:" format
  const userMessages = [];
  const aiMessages = [];
  
  // Split by "You said:" markers (Claude's format)
  const youSaidParts = cleanedText.split(/You said:\s*/);
  if (youSaidParts.length > 1) {
    for (let i = 1; i < youSaidParts.length; i++) {
      const part = youSaidParts[i];
      // Split user message from AI response
      const aiSplit = part.split(/Claude responded:\s*/);
      if (aiSplit.length >= 2) {
        userMessages.push(aiSplit[0].trim().slice(0, 500));
        aiMessages.push(aiSplit[1].trim().slice(0, 2000));
      } else {
        userMessages.push(part.trim().slice(0, 500));
      }
    }
  }

  if (userMessages.length > 0) {
    // We successfully parsed the conversation structure
    result.totalMessages = userMessages.length + aiMessages.length;
    result.goal = userMessages[0].slice(0, 500);
    result.sessionType = classifySessionType(result.goal);
    
    // Last 3 exchanges
    const pairs = [];
    const pairCount = Math.min(userMessages.length, aiMessages.length);
    for (let i = 0; i < pairCount; i++) {
      pairs.push({ user: userMessages[i].slice(0, 300), assistant: aiMessages[i].slice(0, 500) });
    }
    result.lastExchanges = pairs.slice(-10);
    
    // Key outputs: longer AI responses
    result.keyOutputs = aiMessages
      .filter(m => m.length > 200)
      .slice(-3)
      .map(m => m.slice(0, 1000));
    
    // Code blocks
    const codeElements = document.querySelectorAll('pre code, code');
    result.codeBlocks = Array.from(codeElements)
      .map(el => el.textContent || '')
      .filter(text => text.length > 20)
      .slice(-3)
      .map(c => c.slice(0, 500));
  } else {
    // Couldn't parse structure — use raw chunks
    result.goal = cleanedText.slice(0, 500).trim();
    result.totalMessages = 1;
    result.sessionType = classifySessionType(result.goal);
    
    if (cleanedText.length > 500) {
      const lastChunk = cleanedText.slice(-3000).trim();
      result.keyOutputs = [lastChunk.slice(0, 1500)];
      result.lastExchanges = [{ user: result.goal.slice(0, 200), assistant: lastChunk.slice(0, 500) }];
    }
    result.lastExchanges = [{ user: result.goal.slice(0, 200), assistant: lastChunk.slice(0, 500) }];
  }

  // Extract code blocks from the page
  const codeElements = document.querySelectorAll('pre code, code');
  result.codeBlocks = Array.from(codeElements)
    .map(el => el.textContent || '')
    .filter(text => text.length > 20);

  return result;
}

/**
 * Build a complete context from found user/assistant message elements
 */
function buildContext(context, userMessages, assistantMessages, codeBlockSelector) {
  const result = { ...context };
  
  result.totalMessages = userMessages.length + assistantMessages.length;

  // Goal extraction
  if (userMessages.length > 0) {
    result.goal = userMessages[0].textContent?.trim() || '';
  }

  // Code blocks
  const codeElements = document.querySelectorAll(codeBlockSelector);
  result.codeBlocks = Array.from(codeElements).map(el => el.textContent || '');

  // Key outputs
  result.keyOutputs = Array.from(assistantMessages)
    .filter(el => {
      const text = el.textContent || '';
      const hasCodeBlock = el.querySelector(codeBlockSelector) !== null;
      return text.length > 200 && !hasCodeBlock;
    })
    .map(el => el.textContent.trim());

  // Last exchanges
  const pairs = [];
  const userArr = Array.from(userMessages);
  const assistantArr = Array.from(assistantMessages);
  const pairCount = Math.min(userArr.length, assistantArr.length);
  for (let i = 0; i < pairCount; i++) {
    pairs.push({
      user: userArr[i].textContent?.trim() || '',
      assistant: assistantArr[i].textContent?.trim() || ''
    });
  }
  result.lastExchanges = pairs.slice(-10);

  // Error messages
  const errorKeywords = ['error', 'fix', 'issue', 'bug'];
  const allMessages = [...Array.from(userMessages), ...Array.from(assistantMessages)];
  result.errorMessages = allMessages
    .filter(el => {
      const text = (el.textContent || '').toLowerCase();
      return errorKeywords.some(keyword => text.includes(keyword));
    })
    .map(el => el.textContent.trim());

  // Session type
  result.sessionType = classifySessionType(result.goal);

  return result;
}

/**
 * Classify session type based on goal keywords.
 * Priority: coding > writing > research > general
 * If goal is empty/whitespace, returns 'general'.
 * @param {string} goal - The goal text (first user message)
 * @returns {'coding' | 'writing' | 'research' | 'general'}
 */
function classifySessionType(goal) {
  if (!goal || !goal.trim()) {
    return 'general';
  }

  const lowerGoal = goal.toLowerCase();

  const codingKeywords = ['code', 'function', 'script', 'bug', 'error', 'api', 'class', 'debug'];
  const writingKeywords = ['write', 'essay', 'article', 'draft', 'paragraph', 'blog'];
  const researchKeywords = ['research', 'explain', 'what is', 'how does', 'summarize'];

  if (codingKeywords.some(kw => lowerGoal.includes(kw))) {
    return 'coding';
  }
  if (writingKeywords.some(kw => lowerGoal.includes(kw))) {
    return 'writing';
  }
  if (researchKeywords.some(kw => lowerGoal.includes(kw))) {
    return 'research';
  }

  return 'general';
}

// Export for use by content scripts and tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractContext, classifySessionType };
}

// Expose globally for content scripts to call
if (typeof window !== 'undefined') {
  window.__relayExtractContextFn = extractContext;
  window.__relayClassifySessionType = classifySessionType;
}

// Listen for extraction requests from popup or service worker
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RELAY_EXTRACT_CONTEXT') {
      const platform = message.platform || 'unknown';
      const selectors = message.selectors || {
        message_selectors: {
          user: platform === 'chatgpt' ? "[data-message-author-role='user']" : "[data-testid^='human-turn']",
          assistant: platform === 'chatgpt' ? "[data-message-author-role='assistant']" : "[data-testid^='ai-turn']"
        },
        code_block_selectors: ['pre code']
      };

      const raw = extractContext(platform, selectors);

      // Truncate for serialization
      const result = {
        platform: raw.platform,
        goal: (raw.goal || '').slice(0, 2000),
        codeBlocks: (raw.codeBlocks || []).slice(-2).map(c => c.slice(0, 500)),
        keyOutputs: (raw.keyOutputs || []).slice(0, 3).map(k => k.slice(0, 1000)),
        lastExchanges: (raw.lastExchanges || []).slice(-2).map(e => ({
          user: (e.user || '').slice(0, 300),
          assistant: (e.assistant || '').slice(0, 300)
        })),
        errorMessages: (raw.errorMessages || []).slice(0, 5),
        sessionType: raw.sessionType,
        totalMessages: raw.totalMessages,
        extractedAt: raw.extractedAt
      };

      sendResponse(result);
      return true; // async response
    }
  });
}
