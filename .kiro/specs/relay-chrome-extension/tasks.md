# Implementation Plan: Relay Chrome Extension

## Overview

This plan implements the Relay Chrome Extension — a Manifest V3 extension that detects free-tier usage limits on ChatGPT and Claude, extracts conversation context, and hands off the session to the other platform. Tasks are ordered by dependency: project setup first, then core infrastructure, then feature modules, then integration.

## Tasks

- [x] 1. Create `manifest.json` with Manifest V3 configuration: `manifest_version: 3`, extension name "Relay", permissions (`storage`, `alarms`, `scripting`, `notifications`), host_permissions (`*://chatgpt.com/*`, `*://claude.ai/*`), background service worker (`background/service-worker.js`), content scripts (chatgpt.js at `document_start`, claude.js at `document_idle`), popup action (`popup/popup.html`), and web_accessible_resources (`config/selectors.json`, `extractor/extractor.js`).
- [x] 2. Create `config/selectors.json` with the `remote_url` field pointing to a GitHub raw URL, and platform entries for `chatgpt` and `claude` containing `limit_triggers`, `warning_triggers`, `message_selectors` (user/assistant), `code_block_selectors`, `input_selector`, and `reset_window_hours` fields with initial placeholder selectors.
- [x] 3. Create placeholder icon files (`icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`) and initialize `package.json` with Vitest and fast-check as dev dependencies for testing.
- [x] 4. Create `background/service-worker.js` with the `chrome.runtime.onInstalled` listener that initializes `relay_usage` in `chrome.storage.local` with both platforms set to `status: 'unknown'`, `messagesThisWindow: 0`, `estimatedLimit: null`, `limitHitAt: null`, `estimatedResetAt: null`, and `lastUpdated` as current timestamp.
- [x] 5. Implement remote selectors fetch in the service worker: on start, read `remote_url` from bundled `config/selectors.json`, fetch the remote file, store in `chrome.storage.local` under `relay_selectors`. Fall back to bundled local file if fetch fails or response is not valid JSON.
- [x] 6. Implement the service worker message listener for `LIMIT_DETECTED`: update the platform's `relay_usage` record to `status: 'cooldown'`, set `limitHitAt` to current timestamp, calculate `estimatedResetAt` using `reset_window_hours` from selectors, and create a `chrome.alarms` entry for the reset time.
- [x] 7. Implement the service worker message listener for `WARNING_DETECTED`: update the platform's `relay_usage` record with the remaining count if provided, and set `status` to `warning` if `messagesThisWindow` exceeds 80% of `estimatedLimit`.
- [x] 8. Implement the `chrome.alarms.onAlarm` listener in the service worker: when a platform's reset alarm fires, reset `messagesThisWindow` to 0 and set `status` to `available`.
- [x] 9. Implement ChatGPT message counting in the service worker via `chrome.webRequest.onBeforeRequest` for URLs matching `*://chatgpt.com/backend-api/conversation`: increment `messagesThisWindow` for the ChatGPT platform record on each outgoing POST request.
- [x] 10. Implement the service worker message listener for `CONTEXT_EXTRACTED`: store the received Session_Context in `chrome.storage.local` under `relay_pending_handoff`, overwriting any existing value.
- [x] 11. Implement the service worker message listener for `BATON_PASS_REQUESTED`: determine target URL (ChatGPT → `https://claude.ai/new`, Claude → `https://chatgpt.com`), open via `chrome.tabs.create()`, set up a 30-second timeout, and listen for `chrome.tabs.onUpdated` with `status === 'complete'` on the new tab.
- [x] 12. Implement the service worker tab-ready handler: when the new tab reaches `status === 'complete'`, clear the timeout and execute `handoff/injector.js` in the new tab via `chrome.scripting.executeScript()`. On timeout, remove the listener and store a `TAB_LOAD_TIMEOUT` error for the popup.
- [x] 13. Create `content/chatgpt.js` with the `window.fetch` override: store original fetch, override with async wrapper that clones responses from `backend-api/conversation`, checks for rate-limit signals (`detail` containing "rate" or `error` field), sends `LIMIT_DETECTED` to service worker if found, and always returns the original unmodified response. Silently catch JSON parse errors.
- [x] 14. Implement the MutationObserver in `chatgpt.js`: listen for `SELECTORS_READY` message from service worker, attach observer to `document.body` with `{ childList: true, subtree: true }`, check added nodes against `limit_triggers` and `warning_triggers` selectors, send appropriate messages to service worker.
- [x] 15. Implement the Baton Pass floating card UI in `chatgpt.js`: on limit confirmation, create a fixed-position card (bottom-right, z-index 999999) with slide-in animation, CTA button ("Continue in Claude →"), dismiss button ("✕"), and first-click-wins logic. Show both reset timers when both platforms are in cooldown.
- [x] 16. Implement the CTA click handler in `chatgpt.js`: invoke the extractor, send `CONTEXT_EXTRACTED` with Session_Context, send `BATON_PASS_REQUESTED` to service worker, and remove the floating card from DOM.
- [x] 17. Create `content/claude.js` with SSE stream interception: override `window.fetch` for streaming responses to Claude's API, read the response body as a stream, parse SSE events for `message_limit` event type, extract remaining count. On remaining 0 send `LIMIT_DETECTED`, on remaining > 0 send `WARNING_DETECTED` with count. On any parse failure, set flag to disable SSE and fall back to DOM observation.
- [x] 18. Implement the MutationObserver in `claude.js` (same pattern as chatgpt.js but with Claude-specific selectors).
- [x] 19. Implement the Baton Pass floating card UI in `claude.js` (same component as chatgpt.js but targeting ChatGPT as destination) with CTA click handler that invokes extractor and sends messages to service worker.
- [x] 20. Create `extractor/extractor.js` with the main `extractContext(platform, selectors)` function: query DOM for user/assistant messages using `message_selectors`, implement the empty-conversation guard (return zeroed Session_Context if no messages found).
- [x] 21. Implement `goal` extraction (first user message text), `codeBlocks` extraction (all code block contents), and `keyOutputs` extraction (assistant messages > 200 chars without code block children) in the extractor.
- [x] 22. Implement `lastExchanges` extraction (last 3 user-assistant pairs), `errorMessages` extraction (messages containing error/fix/issue/bug case-insensitive), `totalMessages` count, and `extractedAt` ISO 8601 timestamp in the extractor.
- [x] 23. Implement `sessionType` classification in the extractor: inspect goal for keywords with priority — coding (`code`, `function`, `script`, `bug`, `error`, `API`, `class`, `debug`), writing (`write`, `essay`, `article`, `draft`, `paragraph`, `blog`), research (`research`, `explain`, `what is`, `how does`, `summarize`), default `general`.
- [x] 24. Write property-based tests for the extractor using fast-check: test session type determinism (Property 3), field completeness (Property 2), error message keyword detection (Property 10), key outputs filter (Property 11), and last exchanges bounded (Property 12).
- [x] 25. Create the `buildHandoffPrompt(context)` function in `handoff/injector.js`: construct the prompt with `[RELAY HANDOFF]` header, session type, source platform, goal (or "Not specified"), progress/key outputs (or "No outputs generated yet"), last code output (omit if empty), recent exchange (or "This is the first interaction"), and continuation instruction.
- [x] 26. Write property-based tests for the prompt builder using fast-check: test prompt structure (Property 4) — always starts with `[RELAY HANDOFF]`, always ends with continuation instruction, goal/keyOutputs/lastExchanges always present, codeBlocks section conditional.
- [x] 27. Create `handoff/injector.js` main injection flow: read `relay_pending_handoff` from `chrome.storage.local`, validate data (abort with notification if missing/invalid), build Handoff_Prompt, detect platform from URL, set up MutationObserver to wait for input field.
- [x] 28. Implement ChatGPT injection in the injector: use `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, prompt)` then dispatch `input` event with `{ bubbles: true }`.
- [x] 29. Implement Claude injection in the injector: focus the `contenteditable` element, create `DataTransfer` with `setData('text/plain', prompt)`, dispatch `InputEvent` with `{ inputType: 'insertFromPaste', dataTransfer, bubbles: true, cancelable: true }`.
- [x] 30. Implement injection success cleanup (delete `relay_pending_handoff`) and failure fallback (copy to clipboard, notify only if clipboard succeeds, abort notification if data missing).
- [x] 31. Create `popup/popup.html` with header ("⚡ Relay Fleet Status"), platform status rows, and smart suggestion section. Create `popup/popup.css` with compact layout (300px width), status indicators, countdown timer styling.
- [x] 32. Create `popup/popup.js` that reads `relay_usage` from `chrome.storage.local` on open and renders each platform with status indicator emoji (🟢 available, 🟡 warning, 🔴 cooldown with HH:MM:SS countdown, ⚪ unknown). Implement `setInterval(1000)` for live countdown refresh.
- [x] 33. Implement the smart suggestion logic in the popup: recommend platform with highest `(estimatedLimit - messagesThisWindow) / estimatedLimit` ratio among available/warning platforms. Show "No platforms available" with both timers if all cooldown. Add `chrome.storage.onChanged` listener for live updates.
- [x] 34. Write property-based tests for the smart suggestion logic using fast-check (Property 13).
- [x] 35. Create `cloudflare-worker/worker.js` handling POST `/summarize`: validate request body (`text` and `tier` fields), select model (`llama-3.1-8b-instant` for free, `llama-3.3-70b-versatile` for pro), read `GROQ_API_KEY` from env, forward to Groq API, return summary. On error return 502 with generic message. No logging/persistence.
- [x] 36. Create `wrangler.toml` for Cloudflare Worker deployment with the `GROQ_API_KEY` secret reference.
- [x] 37. Write property-based tests for usage tracking state machine (Property 7): verify only valid status transitions occur.
- [x] 38. Write property-based tests for cooldown reset correctness (Property 8): verify `estimatedResetAt` calculation and reset behavior.
- [x] 39. Write property-based tests for pending handoff singleton (Property 9): verify only one pending handoff exists at a time.
- [x] 40. Write integration tests for service worker message routing: mock Chrome APIs, verify correct storage updates for all message types.
- [x] 41. Write integration tests for tab management flow: mock `chrome.tabs.create()` and `chrome.tabs.onUpdated`, verify injector execution on tab complete and timeout handling.
- [x] 42. Verify manifest.json permissions are minimal: confirm no permissions beyond declared set and host_permissions for chatgpt.com and claude.ai only.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "description": "Project setup and configuration",
      "tasks": [1, 2, 3]
    },
    {
      "description": "Service worker core infrastructure",
      "tasks": [4, 5, 6, 7, 8, 9]
    },
    {
      "description": "Service worker baton pass orchestration and extractor module",
      "tasks": [10, 11, 12, 20, 21, 22, 23]
    },
    {
      "description": "Content scripts, prompt builder, and extractor tests",
      "tasks": [13, 14, 15, 16, 17, 18, 19, 24, 25, 26]
    },
    {
      "description": "Injector, popup, and Cloudflare worker",
      "tasks": [27, 28, 29, 30, 31, 32, 33, 35, 36]
    },
    {
      "description": "Testing and verification",
      "tasks": [34, 37, 38, 39, 40, 41, 42]
    }
  ]
}
```

## Notes

- Tasks 1-3 must be completed first as they establish the project structure.
- Tasks 4-12 build the service worker incrementally — each task adds one responsibility.
- Tasks 13-19 (content scripts) depend on the service worker being ready to receive messages.
- Tasks 20-23 (extractor) can be developed in parallel with content scripts since it's a pure DOM-reading module.
- Tasks 25-30 (injector) depend on the extractor and prompt builder being complete.
- Tasks 35-36 (Cloudflare worker) are independent and can be developed in parallel with the extension.
- Property-based test tasks (24, 26, 34, 37-39) should be written alongside or immediately after their corresponding implementation tasks.
