// Relay Chrome Extension - Handoff Injector
// Executed in the target platform tab via chrome.scripting.executeScript()
// Reads relay_pending_handoff from storage, builds the prompt, and injects it

(async function () {
  'use strict';

  const OBSERVER_TIMEOUT = 10000; // 10 seconds
  const HANDOFF_EXPIRY = 10 * 60 * 1000; // 10 minutes

  try {
    // --- Task 27: Main injection flow ---

    // Read pending handoff from chrome.storage.local (Req 15 AC3)
    const data = await chrome.storage.local.get(['relay_pending_handoff']);
    const context = data.relay_pending_handoff;

    // Validate data — abort with notification if missing/invalid (Req 15 AC5, AC6)
    if (!context || !context.platform) {
      await notifyUser('Relay handoff failed: no pending context found.');
      return;
    }

    // Check expiry — abort if older than 10 minutes (Req 15 AC8)
    if (context.extractedAt) {
      const extractedTime = new Date(context.extractedAt).getTime();
      if (Date.now() - extractedTime > HANDOFF_EXPIRY) {
        await chrome.storage.local.remove('relay_pending_handoff');
        await notifyUser('Relay handoff expired. Please try again.');
        return;
      }
    }

    // Build the Handoff_Prompt (Req 8)
    const prompt = buildHandoffPrompt(context);

    // Detect platform from URL
    const url = window.location.href;
    const isChatGPT = url.includes('chatgpt.com');
    const isClaude = url.includes('claude.ai');
    const isGemini = url.includes('gemini.google.com');
    const isGrok = url.includes('grok.com');

    // Determine input selector based on platform
    // Try multiple selectors for robustness
    let inputSelector;
    if (isChatGPT) {
      inputSelector = "textarea#prompt-textarea, div#prompt-textarea, textarea[placeholder*='Message'], div[contenteditable='true'][id='prompt-textarea'], #prompt-textarea";
    } else if (isClaude) {
      inputSelector = "div[contenteditable='true'], div.ProseMirror[contenteditable='true'], fieldset div[contenteditable='true']";
    } else if (isGemini) {
      inputSelector = "div[contenteditable='true'], rich-textarea div[contenteditable='true'], .ql-editor[contenteditable='true'], div.text-input-field_textarea[contenteditable='true']";
    } else if (isGrok) {
      inputSelector = "textarea, div[contenteditable='true'], textarea[placeholder*='Ask']";
    } else {
      // Generic fallback for unknown platforms
      inputSelector = "textarea, div[contenteditable='true']";
    }

    // Wait for input field with MutationObserver (Req 7 AC1, 10s timeout)
    const inputField = await waitForElement(inputSelector, OBSERVER_TIMEOUT);

    if (!inputField) {
      // Timeout elapsed without finding input field (Req 7 AC8)
      await clipboardFallback(prompt);
      return;
    }

    // Inject based on detected platform
    let success = false;
    if (isChatGPT) {
      // ChatGPT may use textarea OR contenteditable div — detect and use appropriate method
      if (inputField.tagName === 'TEXTAREA') {
        success = injectChatGPT(inputField, prompt);
      } else {
        success = injectClaude(inputField, prompt); // contenteditable method works for div#prompt-textarea
      }
    } else if (isClaude) {
      success = injectClaude(inputField, prompt);
    } else if (isGemini || isGrok) {
      // Gemini and Grok use contenteditable or textarea — try both methods
      if (inputField.tagName === 'TEXTAREA') {
        success = injectChatGPT(inputField, prompt); // textarea method
      } else {
        success = injectClaude(inputField, prompt); // contenteditable method
      }
    } else {
      // Generic: try textarea method first, then contenteditable
      if (inputField.tagName === 'TEXTAREA') {
        success = injectChatGPT(inputField, prompt);
      } else {
        success = injectClaude(inputField, prompt);
      }
    }

    // --- Task 30: Success cleanup and failure fallback ---
    if (success) {
      // Delete relay_pending_handoff on success (Req 15 AC4)
      await chrome.storage.local.remove('relay_pending_handoff');
    } else {
      // Injection failed — clipboard fallback (Req 7 AC6)
      await clipboardFallback(prompt);
    }
  } catch (e) {
    // Unexpected error — attempt clipboard fallback
    try {
      const data = await chrome.storage.local.get(['relay_pending_handoff']);
      if (data.relay_pending_handoff) {
        const prompt = buildHandoffPrompt(data.relay_pending_handoff);
        await clipboardFallback(prompt);
      } else {
        await notifyUser('Relay: Automatic injection failed. Please re-initiate the handoff.');
      }
    } catch (_) {
      await notifyUser('Relay: Automatic injection failed. Please re-initiate the handoff.');
    }
  }

  // --- Helper Functions ---

  /**
   * Build the Handoff Prompt from a Session_Context object.
   * Inline version of handoff/prompt-builder.js (cannot import modules in executeScript context).
   * Follows Requirement 8: fixed section order, max 4000 chars, truncation strategy.
   */
  function buildHandoffPrompt(ctx) {
    const MAX_LENGTH = 4000;
    const INSTRUCTION = '---\nPlease acknowledge this context and continue directly from where we left off. Do not ask me to re-explain what I need.';

    const header = '[RELAY HANDOFF]';
    const sessionLine = `Session Type: ${ctx.sessionType || 'general'}`;
    const sourceLine = `Source: ${ctx.platform || 'unknown'}`;

    // Goal section (Req 8 AC4, AC10)
    const goalSection = `\n## Goal\n${ctx.goal || 'Not specified'}`;

    // Progress / Key Outputs section (Req 8 AC5, AC11)
    let keyOutputsContent = (ctx.keyOutputs && ctx.keyOutputs.length > 0)
      ? ctx.keyOutputs.slice(0, 10).join('\n')
      : 'No outputs generated yet';
    let progressSection = `\n## Progress / Key Outputs\n${keyOutputsContent}`;

    // Last Code Output section (Req 8 AC6) — omit entirely if codeBlocks is empty
    let codeSection = '';
    if (ctx.codeBlocks && ctx.codeBlocks.length > 0) {
      codeSection = `\n## Last Code Output\n${ctx.codeBlocks[ctx.codeBlocks.length - 1]}`;
    }

    // Recent Exchange section (Req 8 AC7, AC12)
    // Truncate AI responses to 500 chars max to keep the prompt concise
    let exchangeSection;
    if (ctx.blocker) {
      // Groq-enhanced: use the blocker as the "where we got stuck" section
      exchangeSection = `\n## Where We Got Stuck\n${ctx.blocker}`;
      if (ctx.lastExchanges && ctx.lastExchanges.length > 0) {
        const last = ctx.lastExchanges[ctx.lastExchanges.length - 1];
        const userMsg = (last.user || '').slice(0, 300);
        const aiMsg = (last.assistant || '').slice(0, 500);
        exchangeSection += `\n\nLast exchange:\nUser: ${userMsg}\nAI: ${aiMsg}${last.assistant.length > 500 ? '...' : ''}`;
      }
    } else if (ctx.lastExchanges && ctx.lastExchanges.length > 0) {
      const last = ctx.lastExchanges[ctx.lastExchanges.length - 1];
      const userMsg = (last.user || '').slice(0, 300);
      const aiMsg = (last.assistant || '').slice(0, 500);
      exchangeSection = `\n## Recent Exchange\nUser: ${userMsg}\nAI: ${aiMsg}${last.assistant.length > 500 ? '...' : ''}`;
    } else {
      exchangeSection = '\n## Recent Exchange\nThis is the first interaction';
    }

    // Assemble prompt in fixed order (Req 8 AC9)
    let prompt = [
      header, sessionLine, sourceLine,
      goalSection, progressSection, codeSection, exchangeSection,
      '\n' + INSTRUCTION
    ].join('\n');

    // Truncation strategy (Req 8 AC14): oldest keyOutputs first, then code block
    if (prompt.length > MAX_LENGTH) {
      let outputs = (ctx.keyOutputs || []).slice(0, 10);
      while (prompt.length > MAX_LENGTH && outputs.length > 0) {
        outputs.shift();
        keyOutputsContent = outputs.length > 0 ? outputs.join('\n') : 'No outputs generated yet';
        progressSection = `\n## Progress / Key Outputs\n${keyOutputsContent}`;
        prompt = [
          header, sessionLine, sourceLine,
          goalSection, progressSection, codeSection, exchangeSection,
          '\n' + INSTRUCTION
        ].join('\n');
      }
      if (prompt.length > MAX_LENGTH && codeSection) {
        codeSection = '';
        prompt = [
          header, sessionLine, sourceLine,
          goalSection, progressSection, codeSection, exchangeSection,
          '\n' + INSTRUCTION
        ].join('\n');
      }
    }

    return prompt;
  }

  /**
   * Wait for a DOM element matching the selector to appear.
   * Uses MutationObserver with a timeout (Req 7 AC1).
   * @returns {Promise<Element|null>} The element, or null if timeout elapsed.
   */
  function waitForElement(selector, timeout) {
    return new Promise((resolve) => {
      // Check if element is already present
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(el);
        }
      });

      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });

      const timeoutId = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  // --- Task 28: ChatGPT injection ---

  /**
   * Inject prompt into ChatGPT textarea using React's native input value setter.
   * Uses Object.getOwnPropertyDescriptor to bypass React's synthetic event system (Req 7 AC3).
   * @returns {boolean} true if injection succeeded.
   */
  function injectChatGPT(textarea, prompt) {
    try {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeInputValueSetter.call(textarea, prompt);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- Task 29: Claude injection ---

  /**
   * Inject prompt into Claude's contenteditable element using DataTransfer API.
   * Focuses the element and dispatches an InputEvent with insertFromPaste (Req 7 AC4).
   * @returns {boolean} true if injection succeeded.
   */
  function injectClaude(editor, prompt) {
    try {
      editor.focus();

      // Method 1: DataTransfer API (preferred for modern contenteditable)
      try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', prompt);
        const inputEvent = new InputEvent('input', {
          inputType: 'insertFromPaste',
          dataTransfer: dataTransfer,
          bubbles: true,
          cancelable: true
        });
        editor.dispatchEvent(inputEvent);
        // Check if it worked
        if (editor.textContent && editor.textContent.length > 10) {
          return true;
        }
      } catch (e) {
        // DataTransfer method failed, try fallback
      }

      // Method 2: execCommand (deprecated but widely supported)
      try {
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, prompt);
        if (editor.textContent && editor.textContent.length > 10) {
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      } catch (e) {
        // execCommand failed, try fallback
      }

      // Method 3: Direct innerHTML/textContent set + input event
      try {
        editor.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = prompt;
        editor.appendChild(p);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch (e) {
        // All methods failed
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  // --- Task 30: Clipboard fallback and notifications ---

  /**
   * Clipboard fallback: copy prompt to clipboard and notify user.
   * Only notifies if clipboard write succeeds (Req 7 AC6).
   * If both injection and clipboard fail, notify about failure (Req 7 AC7).
   */
  async function clipboardFallback(prompt) {
    try {
      await navigator.clipboard.writeText(prompt);
      await notifyUser('Relay: Prompt copied to clipboard. Paste it into the chat.');
    } catch (e) {
      // Both injection and clipboard failed (Req 7 AC7)
      await notifyUser('Relay: Automatic injection failed. Please re-initiate the handoff.');
    }
  }

  /**
   * Send a browser notification to the user.
   * Silently fails if notifications API is unavailable.
   */
  async function notifyUser(message) {
    try {
      if (chrome.notifications) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon48.png'),
          title: 'Relay',
          message: message
        });
      }
    } catch (e) {
      // Notifications may not be available in this context — silently fail
    }
  }
})();
