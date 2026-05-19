# Design Document

## Overview

This document describes the implementation plan for the Relay Chrome Extension — a Manifest V3 extension that detects free-tier usage limits on ChatGPT and Claude, extracts conversation context, and seamlessly hands off the session to the other platform.

The architecture follows Chrome MV3 conventions: a service worker for background orchestration, per-platform content scripts for DOM interaction and network interception, a shared extractor module, an injector module for target-tab prompt insertion, and a popup for fleet status display.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chrome Browser                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    chrome.runtime     ┌───────────────────┐  │
│  │ Content Script│◄────────────────────►│  Service Worker    │  │
│  │ (chatgpt.js) │    .sendMessage()     │  (service-worker.js)│ │
│  │              │                       │                     │ │
│  │ • fetch override                     │ • Message routing   │ │
│  │ • MutationObserver                   │ • Usage tracking    │ │
│  │ • Baton Pass UI                      │ • Tab management    │ │
│  └──────────────┘                       │ • Selector fetch    │ │
│                                         │ • Alarm management  │ │
│  ┌──────────────┐    chrome.runtime     │                     │ │
│  │ Content Script│◄────────────────────►│                     │ │
│  │ (claude.js)  │    .sendMessage()     └─────────┬───────────┘ │
│  │              │                                 │             │
│  │ • SSE interception                             │             │
│  │ • MutationObserver                             │             │
│  │ • Baton Pass UI                    chrome.storage.local      │
│  └──────────────┘                                 │             │
│                                         ┌─────────▼───────────┐ │
│  ┌──────────────┐                       │  Local Storage       │ │
│  │   Injector   │◄─────────────────────►│  • relay_selectors   │ │
│  │(injector.js) │  reads pending_handoff│  • relay_usage       │ │
│  │              │                       │  • relay_pending_    │ │
│  │ • MutationObserver wait              │    handoff           │ │
│  │ • React setter (ChatGPT)            └───────────────────────┘ │
│  │ • DataTransfer (Claude)                                      │
│  └──────────────┘                                               │
│                                                                 │
│  ┌──────────────┐                                               │
│  │    Popup     │◄──── reads relay_usage from storage           │
│  │ (popup.html) │                                               │
│  │              │                                               │
│  │ • Fleet status display                                       │
│  │ • Countdown timers                                           │
│  │ • Smart suggestion                                           │
│  └──────────────┘                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

                    ┌───────────────────────┐
                    │  Cloudflare Worker    │  (V2 only)
                    │  (worker.js)          │
                    │                       │
                    │  • Groq API proxy     │
                    │  • Model selection    │
                    │  • Ephemeral only     │
                    └───────────────────────┘
```

## Components and Interfaces

### 1. manifest.json

**Purpose:** Chrome extension manifest defining permissions, content scripts, service worker, and popup.

**Key Configuration:**
- `manifest_version`: 3
- `permissions`: `storage`, `alarms`, `scripting`, `notifications`
- `host_permissions`: `*://chatgpt.com/*`, `*://claude.ai/*`
- `background.service_worker`: `background/service-worker.js`
- `content_scripts`: Two entries — one for `chatgpt.com` (run_at: `document_start`), one for `claude.ai` (run_at: `document_idle`)
- `action.default_popup`: `popup/popup.html`
- `web_accessible_resources`: `config/selectors.json`, `extractor/extractor.js`

**Design Decisions:**
- ChatGPT content script runs at `document_start` to override `window.fetch` before page scripts execute (Req 2).
- Claude content script runs at `document_idle` since SSE interception doesn't require early injection.
- `scripting` permission needed for `chrome.scripting.executeScript()` to inject the Injector into new tabs (Req 9).

---

### 2. config/selectors.json

**Purpose:** Platform-specific CSS selectors and configuration for limit detection, message extraction, and reset windows.

**Schema:**
```json
{
  "remote_url": "https://raw.githubusercontent.com/<owner>/<repo>/main/selectors.json",
  "platforms": {
    "chatgpt": {
      "limit_triggers": ["<selector1>", "<selector2>"],
      "warning_triggers": ["<selector>"],
      "message_selectors": {
        "user": "<selector>",
        "assistant": "<selector>"
      },
      "code_block_selectors": ["<selector>"],
      "input_selector": "<textarea selector>",
      "reset_window_hours": 3
    },
    "claude": {
      "limit_triggers": ["<selector1>"],
      "warning_triggers": ["<selector>"],
      "message_selectors": {
        "user": "<selector>",
        "assistant": "<selector>"
      },
      "code_block_selectors": ["<selector>"],
      "input_selector": "<contenteditable selector>",
      "reset_window_hours": 4
    }
  }
}
```

**Design Decisions:**
- `remote_url` is stored in the bundled file itself so the service worker knows where to fetch updates (Req 4 AC1).
- Selectors are arrays to support multiple fallback selectors per trigger type.
- `reset_window_hours` is per-platform since ChatGPT and Claude have different reset periods.

---

### 3. background/service-worker.js

**Purpose:** Central orchestrator — handles message routing, usage tracking, selector fetching, tab management, and alarm-based reset timers.

**Responsibilities:**
- On `chrome.runtime.onInstalled`: Initialize `relay_usage` with both platforms in `unknown` state (Req 10 AC9).
- On service worker start: Fetch remote selectors, store in `relay_selectors`, fall back to bundled if fetch/parse fails (Req 4).
- Listen for `LIMIT_DETECTED` / `WARNING_DETECTED` messages from content scripts → update `relay_usage` (Req 10).
- Listen for `BATON_PASS_REQUESTED` messages → store pending handoff, open target tab, wait for load, execute injector (Req 9, 15).
- Listen for `CONTEXT_EXTRACTED` messages → store Session_Context in `relay_pending_handoff` (Req 15).
- Manage `chrome.alarms` for cooldown reset timers (Req 10 AC6).
- Track ChatGPT outgoing requests via `chrome.webRequest.onBeforeRequest` for message counting (Req 10 AC3).

**Message Protocol:**
```
Content Script → Service Worker:
  { type: 'LIMIT_DETECTED', platform: 'chatgpt'|'claude' }
  { type: 'WARNING_DETECTED', platform: 'chatgpt'|'claude', remaining?: number }
  { type: 'CONTEXT_EXTRACTED', context: SessionContext }
  { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt'|'claude' }

Service Worker → Content Script:
  { type: 'SELECTORS_READY', selectors: object }
  { type: 'PLATFORM_STATUS', status: object }
```

**Tab Load Timeout Logic:**
- After `chrome.tabs.create()`, set a 30-second `setTimeout`.
- Listen on `chrome.tabs.onUpdated` for the new tab's `status === 'complete'`.
- If complete fires first → execute injector, clear timeout.
- If timeout fires first → report `TAB_LOAD_TIMEOUT`, remove listener (Req 9 AC4).

---

### 4. content/chatgpt.js

**Purpose:** Content script for chatgpt.com — handles fetch interception, DOM observation, and Baton Pass UI.

**Key Behaviors:**

**Fetch Override (runs at document_start):**
```javascript
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await originalFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (url?.includes('backend-api/conversation')) {
    const clone = response.clone();
    clone.json().then(data => {
      if (data?.detail?.includes('rate') || data?.error) {
        chrome.runtime.sendMessage({ type: 'LIMIT_DETECTED', platform: 'chatgpt' });
      }
    }).catch(() => {}); // Silently discard parse failures
  }
  return response; // Always return original unmodified
};
```

**MutationObserver Setup:**
- Waits for `SELECTORS_READY` message from service worker.
- Creates observer on `document.body` with `{ childList: true, subtree: true }`.
- On mutation, checks if any added nodes match `limit_triggers` or `warning_triggers`.

**Baton Pass UI:**
- On `LIMIT_DETECTED` confirmation, injects floating card via `createElement`.
- Card uses inline styles (no external CSS dependency) to avoid FOUC.
- First-click-wins: sets a `handled` flag on first button click, ignores subsequent.

---

### 5. content/claude.js

**Purpose:** Content script for claude.ai — handles SSE stream interception, DOM observation, and Baton Pass UI.

**SSE Interception Strategy:**
- Override `EventSource` constructor to intercept SSE connections to Claude's API.
- Alternatively, override `window.fetch` for streaming responses and parse SSE events from the response body using a `ReadableStream` reader.
- Listen for `message_limit` event type in the stream.
- Parse the event data for remaining message count.
- On any parse failure, set a flag to disable SSE detection and rely solely on DOM observation (Req 3 AC4).

**MutationObserver Setup:**
- Same pattern as chatgpt.js but with Claude-specific selectors.
- Acts as primary detection when SSE interception is disabled.

**Baton Pass UI:**
- Same floating card component as chatgpt.js (shared inline styles).
- Displays Claude-specific target (ChatGPT).

---

### 6. extractor/extractor.js

**Purpose:** Shared module for rule-based conversation context extraction. Invoked by content scripts when a Baton Pass is triggered.

**Algorithm:**
1. Receive platform name and selectors as input.
2. Query DOM for all user messages using `message_selectors.user`.
3. Query DOM for all assistant messages using `message_selectors.assistant`.
4. If no messages found → return empty Session_Context (Req 6 AC11).
5. Extract `goal` from first user message.
6. Extract `codeBlocks` from all elements matching `code_block_selectors`.
7. Filter `keyOutputs` from assistant messages (>200 chars, no code block child).
8. Build `lastExchanges` from last 3 user+assistant pairs.
9. Filter `errorMessages` by keyword presence (case-insensitive).
10. Determine `sessionType` from `goal` keywords (priority: coding > writing > research > general).
11. Set `totalMessages` and `extractedAt`.
12. Return complete Session_Context object.

**Session_Context Schema:**
```javascript
{
  platform: 'chatgpt' | 'claude',
  goal: string,
  codeBlocks: string[],
  keyOutputs: string[],
  lastExchanges: Array<{ user: string, assistant: string }>,
  errorMessages: string[],
  sessionType: 'coding' | 'writing' | 'research' | 'general',
  totalMessages: number,
  extractedAt: string // ISO 8601
}
```

---

### 7. handoff/injector.js

**Purpose:** Executed in the target platform tab to inject the Handoff Prompt into the input field.

**Injection Flow:**
1. Read Session_Context from `chrome.storage.local` key `relay_pending_handoff` (Req 15 AC3).
2. If not found or invalid → abort, notify user, return (Req 15 AC5).
3. Build Handoff_Prompt from template (Req 8).
4. Detect platform from URL (chatgpt.com vs claude.ai).
5. Set up MutationObserver to wait for input field (Req 7 AC1).
6. Once input found:
   - **ChatGPT:** Use `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set` to set value, then dispatch `input` event (Req 7 AC3).
   - **Claude:** Focus element, create `DataTransfer` with prompt text, dispatch `InputEvent` with `inputType: 'insertFromPaste'` (Req 7 AC4).
7. Dispatch `input` event to activate send button (Req 7 AC5).
8. Delete `relay_pending_handoff` from storage (Req 15 AC4).
9. On failure → clipboard fallback with conditional notification (Req 7 AC6).

**Handoff Prompt Template:**
```
[RELAY HANDOFF]
Session Type: {sessionType}
Source: {platform}

## Goal
{goal || "Not specified"}

## Progress / Key Outputs
{keyOutputs.join('\n') || "No outputs generated yet"}

## Last Code Output
{codeBlocks[codeBlocks.length - 1]}  // Omitted if empty

## Recent Exchange
{lastExchanges[last] || "This is the first interaction"}

---
Please acknowledge this context and continue directly from where we left off. Do not ask me to re-explain what I need.
```

---

### 8. popup/popup.html + popup.css + popup.js

**Purpose:** Extension popup showing fleet status of all platforms.

**UI Layout:**
```
┌─────────────────────────────┐
│  ⚡ Relay Fleet Status      │
├─────────────────────────────┤
│  🟢 ChatGPT    12/40 msgs  │
│  🔴 Claude     00:45:23    │
├─────────────────────────────┤
│  💡 Use ChatGPT (28 left)  │
└─────────────────────────────┘
```

**Behavior:**
- On popup open: read `relay_usage` from `chrome.storage.local`.
- Render each platform with status indicator emoji.
- For `cooldown` platforms: calculate remaining time from `estimatedResetAt`, display as `HH:MM:SS`, update via `setInterval(1000)`.
- Smart suggestion: pick platform with highest `(estimatedLimit - messagesThisWindow) / estimatedLimit` ratio. If both unknown, show no suggestion. If both cooldown, show "No platforms available" with both timers.
- Popup auto-refreshes on `chrome.storage.onChanged` for live updates.

---

### 9. cloudflare-worker/worker.js

**Purpose:** Cloudflare Worker that proxies summarization requests to the Groq API (V2 infrastructure).

**Request Schema:**
```json
POST /summarize
{
  "text": "<conversation text>",
  "tier": "free" | "pro"
}
```

**Response Schema:**
```json
{
  "summary": "<summarized context>",
  "model": "llama-3.1-8b-instant" | "llama-3.3-70b-versatile"
}
```

**Implementation:**
- Read `GROQ_API_KEY` from `env` (Cloudflare Worker secret).
- Select model based on `tier` field.
- Forward to `https://api.groq.com/openai/v1/chat/completions`.
- Return summarized text. No logging, no persistence.
- On error: return 502 with generic error (no conversation text in error response).

---

## Data Models

### Session_Context
```javascript
{
  platform: 'chatgpt' | 'claude',
  goal: string,
  codeBlocks: string[],
  keyOutputs: string[],
  lastExchanges: Array<{ user: string, assistant: string }>,
  errorMessages: string[],
  sessionType: 'coding' | 'writing' | 'research' | 'general',
  totalMessages: number,
  extractedAt: string // ISO 8601
}
```

### Platform Usage Record
```javascript
{
  messagesThisWindow: number,
  estimatedLimit: number | null,
  limitHitAt: string | null,       // ISO 8601
  estimatedResetAt: string | null, // ISO 8601
  lastUpdated: string,             // ISO 8601
  status: 'available' | 'warning' | 'cooldown' | 'unknown'
}
```

### Relay Usage (chrome.storage.local key: `relay_usage`)
```javascript
{
  chatgpt: PlatformUsageRecord,
  claude: PlatformUsageRecord
}
```

### Pending Handoff (chrome.storage.local key: `relay_pending_handoff`)
Same schema as Session_Context — stored temporarily during Baton Pass.

### Selectors Config (chrome.storage.local key: `relay_selectors`)
```javascript
{
  remote_url: string,
  platforms: {
    chatgpt: PlatformSelectors,
    claude: PlatformSelectors
  }
}
```

### Platform Selectors
```javascript
{
  limit_triggers: string[],
  warning_triggers: string[],
  message_selectors: { user: string, assistant: string },
  code_block_selectors: string[],
  input_selector: string,
  reset_window_hours: number
}
```

---

## Data Flow: Complete Baton Pass Sequence

```
1. User hits limit on ChatGPT
2. chatgpt.js fetch override detects rate-limit signal
   OR MutationObserver detects limit_triggers element
3. chatgpt.js sends { type: 'LIMIT_DETECTED', platform: 'chatgpt' } to service worker
4. Service worker updates relay_usage → status: 'cooldown'
5. Service worker sends confirmation back to chatgpt.js
6. chatgpt.js injects Baton Pass floating card
7. User clicks "Continue in Claude →"
8. chatgpt.js invokes extractor.js → produces Session_Context
9. chatgpt.js sends { type: 'CONTEXT_EXTRACTED', context } to service worker
10. Service worker stores context in relay_pending_handoff
11. chatgpt.js sends { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' } to service worker
12. Service worker opens https://claude.ai/new via chrome.tabs.create()
13. Service worker listens for tab status === 'complete' (30s timeout)
14. Tab loads → service worker executes injector.js in new tab
15. injector.js reads relay_pending_handoff from storage
16. injector.js builds Handoff_Prompt from Session_Context
17. injector.js waits for Claude input field via MutationObserver
18. injector.js injects prompt via DataTransfer API
19. injector.js deletes relay_pending_handoff from storage
20. User sees prompt pre-loaded in Claude, ready to send
```

---

## Error Handling

| Failure Scenario | Component | Recovery Action |
|---|---|---|
| Remote selectors fetch fails | Service_Worker | Fall back to bundled `config/selectors.json` silently |
| Remote selectors invalid JSON | Service_Worker | Fall back to bundled `config/selectors.json` silently |
| ChatGPT response not JSON | Content_Script (chatgpt.js) | Discard silently, no user content logged |
| Claude SSE parse failure | Content_Script (claude.js) | Immediately fall back to DOM-based detection |
| Target tab load timeout (30s) | Service_Worker | Report `TAB_LOAD_TIMEOUT` to Popup, abort injection |
| Injection into input field fails | Injector | Copy prompt to clipboard; notify only if clipboard succeeds |
| `relay_pending_handoff` missing | Injector | Abort injection, notify user via browser notification |
| Groq API error/timeout | Service_Worker | Fall back to rule-based extraction, log internally only |
| Both platforms in cooldown | Content_Script + Popup | Show both reset timers, no CTA button |
| `selectors.json` unparseable | Content_Script | Log to console, use empty selector set (no false positives) |

---

## Testing Strategy

- **Unit tests (Vitest):** Extractor logic, prompt template builder, session type classifier, usage state machine transitions.
- **Property-based tests (fast-check):** Extractor field completeness, prompt structure invariants, keyword detection correctness, usage counter monotonicity.
- **Integration tests:** Chrome extension API mocks for message passing, storage operations, tab management.
- **Manual testing:** End-to-end Baton Pass flow on live ChatGPT and Claude pages, selector validation against current DOM structures.

---

## Correctness Properties

### Property 1: Fetch Override Transparency
**Validates: Requirements 2.3**

For any fetch call intercepted by the chatgpt.js override, the response returned to the calling code is byte-identical to what `window.fetch` would have returned without the override. The override only reads a clone — it never modifies the original.

### Property 2: Session_Context Field Completeness
**Validates: Requirements 6.2**

For any valid conversation DOM containing at least one user message, the Extractor produces a Session_Context object where all 9 required fields are present and non-undefined.

### Property 3: Session Type Determinism
**Validates: Requirements 6.8**

For any goal string, the `sessionType` classification is deterministic and follows strict priority: if any coding keyword is present, result is `coding` regardless of other keywords. If no coding keyword but a writing keyword is present, result is `writing`. If no coding or writing keyword but a research keyword is present, result is `research`. Otherwise `general`.

### Property 4: Handoff Prompt Structure
**Validates: Requirements 8.1, 8.4, 8.5, 8.7, 8.8, 8.9, 8.10, 8.11**

For any valid Session_Context, the generated Handoff_Prompt always starts with `[RELAY HANDOFF]` and always ends with the continuation instruction. The `goal`, `keyOutputs`, and `lastExchanges` sections are always present (with placeholders if empty). The `codeBlocks` section is present only when `codeBlocks` is non-empty.

### Property 5: Handoff Prompt Round-Trip Integrity
**Validates: Requirements 15.2, 15.3**

For any Session_Context stored in `relay_pending_handoff`, the Injector reads the same object that was stored — no data loss occurs during the storage/retrieval cycle. `JSON.parse(JSON.stringify(context))` deep-equals the original.

### Property 6: Usage Counter Monotonicity
**Validates: Requirements 10.3**

For the ChatGPT platform, `messagesThisWindow` is monotonically non-decreasing within a single usage window. Each detected outgoing request increments it by exactly 1.

### Property 7: Status State Machine
**Validates: Requirements 10.5, 10.6, 10.7, 10.8**

Platform status transitions follow a valid state machine: `unknown → available`, `unknown → warning`, `available → warning`, `warning → cooldown`, `available → cooldown`, `cooldown → available`. No other transitions are valid. `warning → available` is not valid (messages don't decrease within a window).

### Property 8: Cooldown Reset Correctness
**Validates: Requirements 10.5, 10.6**

When a platform enters `cooldown`, `estimatedResetAt = limitHitAt + (reset_window_hours * 3600000)ms`. When the alarm fires at `estimatedResetAt`, `messagesThisWindow` resets to 0 and `status` becomes `available`.

### Property 9: Pending Handoff Singleton
**Validates: Requirements 15.6**

At any point in time, there is at most one `relay_pending_handoff` entry in storage. A new Baton Pass always overwrites any existing entry.

### Property 10: Error Message Keyword Detection
**Validates: Requirements 6.7**

A message is included in `errorMessages` if and only if its text content contains at least one of the keywords `error`, `fix`, `issue`, `bug` (case-insensitive match). No false positives (messages without keywords) and no false negatives (messages with keywords that are missed).

### Property 11: Key Outputs Filter
**Validates: Requirements 6.5**

An assistant message is included in `keyOutputs` if and only if its text length exceeds 200 characters AND it does not contain a code block element as a child. Both conditions must hold.

### Property 12: Last Exchanges Bounded
**Validates: Requirements 6.6**

`lastExchanges` always contains at most 3 entries. For a conversation with N user-assistant pairs, `lastExchanges.length === min(3, N)` and the entries are the last N pairs in chronological order.

### Property 13: Smart Suggestion Optimality
**Validates: Requirements 11.7**

The popup's smart suggestion always recommends the platform with the highest `(estimatedLimit - messagesThisWindow) / estimatedLimit` ratio among platforms with status `available` or `warning`. If all platforms are `cooldown` or `unknown`, no platform is recommended.

---

## Edge Cases

1. **Both platforms in cooldown:** Baton Pass UI shows both reset timers instead of CTA. Popup shows both timers and "no platform available" message.
2. **Empty conversation:** Extractor returns zeroed Session_Context. Handoff prompt uses all placeholder texts.
3. **Injection failure:** Clipboard fallback with conditional notification (only if clipboard write succeeds).
4. **Tab load timeout:** 30-second timer fires, `TAB_LOAD_TIMEOUT` reported, injection aborted.
5. **Remote selectors invalid JSON:** Silent fallback to bundled local file.
6. **SSE parse failure:** Immediate fallback to DOM-based detection, no retry.
7. **First install:** Both platforms initialized to `unknown` status with zero counts.
8. **Rapid double-click on Baton Pass buttons:** First click wins, second ignored.
9. **Missing pending_handoff at injection time:** Abort with user notification.
10. **ChatGPT response not JSON:** Silently discarded, no user content logged.
