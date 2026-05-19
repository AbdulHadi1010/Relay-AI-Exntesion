# Requirements Document

## Introduction

Relay is a Chrome extension (Manifest V3) that silently monitors AI chat sessions on ChatGPT and Claude. When a free-tier usage limit is detected, Relay intercepts the session, extracts the conversation context using rule-based extraction, wraps it in a structured handoff prompt, and opens the next available AI platform with the full context pre-loaded. The user never needs to copy, paste, or re-explain their work.

Target users are students and free-tier AI users who rotate between ChatGPT and Claude to avoid paid subscriptions. The core value proposition is: "Never hit an AI dead end again."

## Glossary

- **Relay**: The Chrome extension described in this document.
- **Baton Pass**: The core feature that detects a usage limit and transfers the conversation to another platform.
- **Platform**: An AI chat service supported by Relay — currently ChatGPT (chatgpt.com) and Claude (claude.ai).
- **Service_Worker**: The Chrome Extension Manifest V3 background service worker (`background/service-worker.js`).
- **Content_Script**: A per-platform JavaScript file injected into AI chat pages (`content/chatgpt.js`, `content/claude.js`).
- **Extractor**: The rule-based context extraction module (`extractor/extractor.js`).
- **Injector**: The handoff prompt injection module (`handoff/injector.js`).
- **Popup**: The Fleet Status popup UI (`popup/popup.html`, `popup.js`).
- **Selector**: A CSS selector string used to identify DOM elements on a platform page.
- **selectors.json**: The configuration file containing per-platform selectors and limit detection rules.
- **Remote_Selectors**: The `selectors.json` fetched from a remote GitHub URL at extension load time.
- **Handoff_Prompt**: The structured text block injected into the target platform's input field to resume the conversation.
- **Session_Context**: The extracted data object produced by the Extractor, containing goal, code blocks, key outputs, last exchanges, and session metadata.
- **Limit_Banner**: A DOM element that appears on a platform page when the free-tier message limit is reached.
- **SSE_Stream**: A Server-Sent Events stream used by Claude to deliver API responses.
- **Groq_Worker**: The Cloudflare Worker proxy (`cloudflare-worker/worker.js`) that forwards summarization requests to the Groq API.
- **Fleet_Status**: The per-platform usage state tracked by Relay — one of: `available`, `warning`, `cooldown`, or `unknown`.
- **Reset_Window**: The time period after which a platform's usage limit resets, expressed in hours per platform in `selectors.json`.
- **Pending_Handoff**: The temporary `chrome.storage.local` entry (key: `relay_pending_handoff`) that holds the Session_Context between extraction in the source tab and injection in the target tab.

---

## Requirements

### Requirement 1: Limit Detection via DOM Observation

**User Story:** As a free-tier AI user, I want Relay to automatically detect when I have hit a usage limit on ChatGPT or Claude, so that I am notified immediately without having to notice the limit banner myself.

#### Acceptance Criteria

1. WHEN the Content_Script is injected into a supported platform page, THE Content_Script SHALL attach a `MutationObserver` to the page's DOM to watch for elements matching the `limit_triggers` and `warning_triggers` selectors defined in `selectors.json` for that platform.
2. WHEN a DOM element matching a `limit_triggers` selector is inserted into the observed subtree, THE Content_Script SHALL send a `LIMIT_DETECTED` message to the Service_Worker within 500ms of the element being added to the DOM.
3. WHEN a DOM element matching a `warning_triggers` selector is inserted into the observed subtree, THE Content_Script SHALL send a `WARNING_DETECTED` message to the Service_Worker within 500ms of the element being added to the DOM.
4. IF a `LIMIT_DETECTED` or `WARNING_DETECTED` message has already been sent for a given selector match during the current page session, THEN THE Content_Script SHALL NOT send a duplicate message for the same selector until the matching element is removed from the DOM and re-inserted.
5. IF the `selectors.json` file cannot be fetched or cannot be parsed, THEN THE Content_Script SHALL log an error to the browser console and continue operating with an empty selector set, producing no false positives.
6. THE Content_Script SHALL observe the full document body subtree, including dynamically inserted child nodes, for selector matches.

---

### Requirement 2: Limit Detection via Fetch Interception (ChatGPT)

**User Story:** As a free-tier ChatGPT user, I want Relay to detect rate-limit signals from ChatGPT's API responses, so that limits are caught even when the DOM banner has not yet rendered.

#### Acceptance Criteria

1. WHEN the Content_Script is injected into a ChatGPT page at `document_start`, THE Content_Script SHALL override `window.fetch` to intercept outgoing fetch calls before the page's own scripts execute.
2. WHEN a fetch response from a URL containing `backend-api/conversation` returns HTTP status 429, or returns a JSON body whose `detail` field contains the substring "rate" (case-insensitive), or whose top-level `error` field is a non-null value, THE Content_Script SHALL send a `LIMIT_DETECTED` message to the Service_Worker for the ChatGPT platform.
3. THE Content_Script SHALL clone the response before reading its body, and SHALL return the original unmodified response to the calling page code — the override SHALL NOT modify, block, or add more than 50 milliseconds of latency to any request or response.
4. IF the cloned response body cannot be parsed as JSON, THEN THE Content_Script SHALL discard the response silently without logging user content.
5. IF the cloned response body exceeds 1 MB in size, THEN THE Content_Script SHALL skip parsing and discard the response without sending a message to the Service_Worker.

---

### Requirement 3: Limit Detection via SSE Stream Interception (Claude)

**User Story:** As a free-tier Claude user, I want Relay to detect usage limits from Claude's SSE stream, so that the exact remaining message count is captured before the limit banner appears.

#### Acceptance Criteria

1. WHEN the Content_Script is injected into a claude.ai page at `document_start`, THE Content_Script SHALL override `window.fetch` to intercept responses from Claude's conversation API endpoint that return an SSE stream, and SHALL monitor the stream for `message_limit` events.
2. THE Content_Script SHALL clone the SSE stream before reading its events, and SHALL return the original unmodified stream to the calling page code — the override SHALL NOT modify, delay, or block any request or response.
3. WHEN a `message_limit` event is received from the Claude SSE stream, THE Content_Script SHALL extract the remaining message count from the event payload.
4. WHEN a `message_limit` event with a remaining count of zero is received, THE Content_Script SHALL send a `LIMIT_DETECTED` message to the Service_Worker within 500ms of receiving the event.
5. WHEN a `message_limit` event with a remaining count greater than zero is received, THE Content_Script SHALL send a `WARNING_DETECTED` message to the Service_Worker within 500ms of receiving the event, including the remaining count.
6. IF a `message_limit` event cannot be parsed due to an unexpected format, THEN THE Content_Script SHALL activate DOM-based detection as defined in Requirement 1 within 500ms of the parse failure, without dropping or corrupting the in-progress SSE response being delivered to the page.

---

### Requirement 4: Remote Selector Configuration

**User Story:** As a Relay maintainer, I want the extension to fetch updated selectors from a remote source at load time, so that broken selectors can be hot-fixed without requiring a Chrome Web Store update.

#### Acceptance Criteria

1. WHEN the Service_Worker starts, THE Service_Worker SHALL fetch the `selectors.json` file from the remote URL defined in the `remote_url` field of the bundled `config/selectors.json`.
2. WHEN the remote fetch succeeds, THE Service_Worker SHALL store the fetched `selectors.json` content in `chrome.storage.local` under the key `relay_selectors`.
3. WHEN the remote fetch fails for any reason, THE Service_Worker SHALL load the bundled local `config/selectors.json` file and use it as the active selector configuration.
4. THE Service_Worker SHALL complete the selector fetch and storage operation within 5 seconds of the Service_Worker starting, and SHALL NOT inject Content_Scripts into any platform page until the operation completes or the timeout elapses.
5. IF the fetched remote content cannot be parsed as valid JSON, THEN THE Service_Worker SHALL fall back to the bundled local `config/selectors.json` without displaying an error to the user.
6. IF the `remote_url` field in the bundled `config/selectors.json` is missing or empty, THEN THE Service_Worker SHALL use the bundled local `config/selectors.json` as the active selector configuration.
7. IF the fetch timeout of 5 seconds elapses without a response, THEN THE Service_Worker SHALL abort the remote fetch and fall back to the bundled local `config/selectors.json`.

---

### Requirement 5: Baton Pass UI

**User Story:** As a free-tier AI user, I want a clear, non-intrusive UI element to appear when my limit is hit, so that I can transfer my session to another platform with a single click.

#### Acceptance Criteria

1. WHEN a `LIMIT_DETECTED` event is confirmed for the active platform, THE Content_Script SHALL inject a floating card element into the current page's DOM within 500 milliseconds of the event.
2. THE floating card SHALL be positioned fixed at the bottom-right corner of the viewport with a `z-index` of `999999` and SHALL NOT exceed 360 pixels in width or 200 pixels in height.
3. THE floating card SHALL display the name of the target platform and a call-to-action button labeled "Continue in [Target Platform] →".
4. WHEN the user clicks the dismiss button labeled "✕", THE Content_Script SHALL remove the floating card from the DOM.
5. WHEN the floating card is injected, THE Content_Script SHALL apply a slide-in CSS animation with a duration between 200 and 400 milliseconds.
6. THE floating card SHALL remain visible until the user clicks the CTA button or the dismiss button — it SHALL NOT auto-dismiss.
7. WHEN the user clicks either the CTA button or the dismiss button, THE Content_Script SHALL process only the first click event received and ignore any subsequent clicks on either button.
8. IF both platforms are in `cooldown` status, THEN THE Content_Script SHALL display both platform reset timers inside the floating card instead of a CTA button, updating each timer every 1 second.

---

### Requirement 6: Rule-Based Context Extraction

**User Story:** As a free-tier AI user, I want Relay to extract the key context from my current conversation, so that the handoff prompt contains enough information for the target platform to continue my work without re-explanation.

#### Acceptance Criteria

1. WHEN the Extractor is invoked on a platform page, THE Extractor SHALL read the conversation DOM using the `message_selectors` and `code_block_selectors` defined in `selectors.json` for that platform.
2. THE Extractor SHALL produce a Session_Context object containing the following fields: `platform`, `goal`, `codeBlocks`, `keyOutputs`, `lastExchanges`, `errorMessages`, `sessionType`, `totalMessages`, and `extractedAt`.
3. WHEN the first user message in the conversation contains one or more non-whitespace characters, THE Extractor SHALL set `goal` to the trimmed text content of that first user message.
4. IF the first user message in the conversation is empty or contains only whitespace characters, THEN THE Extractor SHALL set `goal` to an empty string and set `sessionType` to `general`.
5. THE Extractor SHALL set `codeBlocks` to an array of all code block text contents found in the conversation, ordered by their appearance in the DOM.
6. THE Extractor SHALL set `keyOutputs` to an array of assistant message text contents that are longer than 200 characters and do not contain a code block.
7. WHEN the conversation contains 3 or more user-and-assistant message pairs, THE Extractor SHALL set `lastExchanges` to the last 3 user-and-assistant message pairs in the conversation.
8. IF the conversation contains fewer than 3 user-and-assistant message pairs, THEN THE Extractor SHALL set `lastExchanges` to all available user-and-assistant message pairs in the conversation.
9. THE Extractor SHALL set `errorMessages` to an array of message text contents that contain at least one of the following terms using case-insensitive matching: `error`, `fix`, `issue`, `bug`.
10. THE Extractor SHALL determine `sessionType` by inspecting the `goal` field for keywords using case-insensitive matching, applying the following priority order: `coding` if any of `code, function, script, bug, error, API, class, debug` are present; otherwise `writing` if any of `write, essay, article, draft, paragraph, blog` are present; otherwise `research` if any of `research, explain, what is, how does, summarize` are present; otherwise `general`.
11. THE Extractor SHALL set `totalMessages` to the total count of all user and assistant messages found in the conversation DOM.
12. THE Extractor SHALL set `extractedAt` to the ISO 8601 timestamp at the moment of extraction.
13. IF no messages are found in the conversation DOM, THEN THE Extractor SHALL return a Session_Context object with `totalMessages` set to `0`, `goal` set to an empty string, `sessionType` set to `general`, and all array fields (`codeBlocks`, `keyOutputs`, `lastExchanges`, `errorMessages`) set to empty arrays.

---

### Requirement 7: Resume Intent Injection

**User Story:** As a free-tier AI user, I want the handoff prompt to be automatically typed into the target platform's input field when the new tab opens, so that I can continue my session without any manual steps.

#### Acceptance Criteria

1. WHEN the Injector is executed in a newly opened target platform tab, THE Injector SHALL use a `MutationObserver` to wait for the platform's input field to be present in the DOM before attempting injection, with a maximum observation timeout of 10 seconds.
2. WHEN the input field is detected, THE Injector SHALL construct a Handoff_Prompt from the Session_Context using the template defined in Requirement 8.
3. WHEN injecting into a ChatGPT textarea, THE Injector SHALL set the input value using React's native input value setter to ensure React's synthetic event system recognizes the change.
4. WHEN injecting into a Claude `contenteditable` input, THE Injector SHALL focus the element and insert the text using the `DataTransfer` API by dispatching an `InputEvent` with `inputType: 'insertFromPaste'` and the prompt text set via `DataTransfer.setData('text/plain', ...)`.
5. WHEN injection succeeds (the target element's visible text content matches the Handoff_Prompt), THE Injector SHALL dispatch an `input` event on the target element to trigger the platform's send-button activation logic.
6. IF injection fails after the input field is detected (the target element's visible text content does not match the Handoff_Prompt within 2 seconds of the injection attempt), THEN THE Injector SHALL copy the Handoff_Prompt text to the clipboard using `navigator.clipboard.writeText()` and, only if the clipboard copy succeeds, notify the user via a browser notification that the prompt has been copied.
7. IF both injection and clipboard copy fail, THEN THE Injector SHALL notify the user via a browser notification that automatic injection was unsuccessful and instruct them to re-initiate the handoff.
8. IF the MutationObserver timeout of 10 seconds elapses without detecting the input field, THEN THE Injector SHALL stop observing, copy the Handoff_Prompt to the clipboard using `navigator.clipboard.writeText()`, and notify the user via a browser notification that the input field could not be found and the prompt has been copied.

---

### Requirement 8: Handoff Prompt Template

**User Story:** As a free-tier AI user, I want the handoff prompt to be structured and informative, so that the target AI platform immediately understands my context and can continue without asking me to re-explain.

#### Acceptance Criteria

1. THE Handoff_Prompt SHALL begin with the header `[RELAY HANDOFF]`.
2. THE Handoff_Prompt SHALL include the `sessionType` field from the Session_Context.
3. THE Handoff_Prompt SHALL include the source platform name.
4. THE Handoff_Prompt SHALL include the `goal` field from the Session_Context as the stated objective.
5. THE Handoff_Prompt SHALL include all entries from the `keyOutputs` array (up to a maximum of 10 entries) from the Session_Context as the progress summary.
6. THE Handoff_Prompt SHALL include the last entry from `codeBlocks` under a "Last Code Output" section. IF `codeBlocks` is empty, THE Handoff_Prompt SHALL omit this section.
7. THE Handoff_Prompt SHALL include the last entry from `lastExchanges` as the most recent exchange.
8. THE Handoff_Prompt SHALL end with a closing instruction that directs the target AI to acknowledge the provided context and continue the task without requesting the user to re-explain prior work.
9. THE Handoff_Prompt SHALL render its sections in the following fixed order: header, sessionType, source platform, goal, progress summary, last code output, recent exchange, closing instruction.
10. IF the `goal` field in the Session_Context is empty, THE Handoff_Prompt SHALL include a goal section with the text "Not specified".
11. IF the `keyOutputs` array in the Session_Context is empty, THE Handoff_Prompt SHALL include a progress summary section with the text "No outputs generated yet".
12. IF the `lastExchanges` array in the Session_Context is empty, THE Handoff_Prompt SHALL include a recent exchange section with the text "This is the first interaction".
13. IF any Session_Context field not explicitly addressed by criteria 10, 11, or 12 is empty or contains an empty array, THE Handoff_Prompt SHALL omit that field's section entirely rather than rendering an empty placeholder.
14. THE Handoff_Prompt SHALL NOT exceed 4000 characters in total length. IF the content exceeds this limit, THE Handoff_Prompt SHALL truncate the `keyOutputs` entries (oldest first) and the `codeBlocks` entry (from the middle, preserving the first 20 and last 20 lines) until the prompt fits within the limit.

---

### Requirement 9: Platform Routing

**User Story:** As a free-tier AI user, I want Relay to automatically open the correct target platform in a new tab when I click the CTA button, so that I am routed to the right place without any manual navigation.

#### Acceptance Criteria

1. WHEN the user clicks the CTA button on the Baton Pass UI while the active tab URL matches the ChatGPT origin (`https://chatgpt.com`), THE Service_Worker SHALL open `https://claude.ai/new` in a new tab via `chrome.tabs.create()`.
2. WHEN the user clicks the CTA button on the Baton Pass UI while the active tab URL matches the Claude origin (`https://claude.ai`), THE Service_Worker SHALL open `https://chatgpt.com` in a new tab via `chrome.tabs.create()`.
3. WHEN the new tab finishes loading (i.e., `chrome.tabs.onUpdated` fires with `status === 'complete'`), THE Service_Worker SHALL execute the Injector in the new tab via `chrome.scripting.executeScript()`.
4. IF the new tab's actual tab status has not reached `status === 'complete'` within 30 seconds, THEN THE Service_Worker SHALL report a `TAB_LOAD_TIMEOUT` error to the Popup and abort the injection attempt.
5. IF `chrome.tabs.create()` fails to open the new tab, THEN THE Service_Worker SHALL report a `TAB_CREATE_FAILED` error to the Popup and abort the routing attempt.
6. IF `chrome.scripting.executeScript()` fails after the new tab has loaded, THEN THE Service_Worker SHALL report a `SCRIPT_INJECTION_FAILED` error to the Popup and leave the new tab open without injected content.
7. WHILE a routing operation is already in progress for the current Baton Pass session, THE Service_Worker SHALL ignore subsequent CTA button clicks until the in-progress operation completes or fails.

---

### Requirement 10: Usage Tracking

**User Story:** As a free-tier AI user, I want Relay to track my usage on each platform, so that I always know how close I am to hitting a limit before it happens.

#### Acceptance Criteria

1. THE Service_Worker SHALL maintain a usage record for each platform in `chrome.storage.local` under the key `relay_usage`.
2. THE usage record for each platform SHALL contain the fields: `messagesThisWindow`, `estimatedLimit`, `limitHitAt`, `estimatedResetAt`, `lastUpdated`, and `status`.
3. WHEN an outgoing POST request to `chatgpt.com/backend-api/conversation` is detected via `chrome.webRequest.onBeforeRequest`, THE Service_Worker SHALL increment `messagesThisWindow` for the ChatGPT platform record and update `lastUpdated` to the current timestamp.
4. WHEN a `message_limit` SSE event is received from Claude, THE Service_Worker SHALL update the Claude platform record's `messagesThisWindow` and `estimatedLimit` using the exact counts from the event payload and update `lastUpdated` to the current timestamp.
5. WHEN a `LIMIT_DETECTED` event is confirmed for a platform, THE Service_Worker SHALL set that platform's `status` to `cooldown`, record `limitHitAt` as the current timestamp, calculate `estimatedResetAt` using the `reset_window_hours` value from `selectors.json`, and update `lastUpdated` to the current timestamp.
6. WHEN `estimatedResetAt` is reached, THE Service_Worker SHALL reset `messagesThisWindow` to `0` and set `status` to `available` using a `chrome.alarms` callback, and update `lastUpdated` to the current timestamp.
7. WHILE a platform's `status` is not `cooldown`, WHEN `messagesThisWindow` exceeds 80% of `estimatedLimit`, THE Service_Worker SHALL set that platform's `status` to `warning`.
8. IF `estimatedLimit` is not yet known for a platform (value is `null`), THEN THE Service_Worker SHALL set that platform's `status` to `unknown` and SHALL NOT evaluate the 80% warning threshold.
9. WHEN the Relay extension is installed for the first time, THE Service_Worker SHALL initialize the `relay_usage` record with both platforms set to `status: 'unknown'`, `messagesThisWindow: 0`, `estimatedLimit: null`, `limitHitAt: null`, `estimatedResetAt: null`, and `lastUpdated` set to the current timestamp.

---

### Requirement 11: Fleet Status Popup

**User Story:** As a free-tier AI user, I want to see the current status of all supported platforms at a glance, so that I can decide which platform to use before hitting a limit.

#### Acceptance Criteria

1. WHEN the Popup is opened, THE Popup SHALL read the `relay_usage` record from `chrome.storage.local` and render the Fleet_Status for each platform, displaying the platform name, status indicator, and usage count within 500 milliseconds.
2. IF a platform has `status === 'available'` (more than 20% of `estimatedLimit` remaining), THEN THE Popup SHALL display a `🟢` indicator next to that platform's name.
3. IF a platform has `status === 'warning'` (20% or fewer of `estimatedLimit` remaining), THEN THE Popup SHALL display a `🟡` indicator next to that platform's name.
4. IF a platform has `status === 'cooldown'`, THEN THE Popup SHALL display a `🔴` indicator accompanied by a live countdown timer in `HH:MM:SS` format showing time remaining until `estimatedResetAt`.
5. IF a platform has `status === 'unknown'`, THEN THE Popup SHALL display a `⚪` indicator next to that platform's name.
6. WHILE a platform is in `cooldown` status, THE Popup SHALL refresh that platform's countdown timer display every 1 second.
7. WHEN a platform's cooldown countdown reaches `00:00:00`, THE Popup SHALL re-read the `relay_usage` record from `chrome.storage.local` and update the Fleet_Status display.
8. THE Popup SHALL display a recommendation line identifying the single platform with the highest remaining capacity (calculated as `estimatedLimit` minus current usage); IF two or more platforms are tied, THEN THE Popup SHALL recommend the platform that appears first in alphabetical order.
9. IF all platforms are in `cooldown` status, THEN THE Popup SHALL display all platform reset timers and a message indicating that no platform is currently available.
10. IF the `relay_usage` record is missing or cannot be parsed from `chrome.storage.local`, THEN THE Popup SHALL display all platforms with the `⚪` indicator and a message indicating that status data is unavailable.

---

### Requirement 12: Groq Smart Summary (V2 Infrastructure)

**User Story:** As a Pro Relay user, I want the extension to use an AI-powered summary of my conversation instead of rule-based extraction, so that the handoff prompt is more concise and accurate for long or complex sessions.

#### Acceptance Criteria

1. THE Groq_Worker SHALL accept POST requests containing conversation text up to a maximum of 128,000 characters and return a summarized context object containing at minimum a condensed conversation summary and a list of extracted key topics.
2. THE Groq_Worker SHALL forward summarization requests to the Groq API using the `llama-3.1-8b-instant` model for free-tier users and the `llama-3.3-70b-versatile` model for Pro users.
3. THE Groq_Worker SHALL read the Groq API key exclusively from an encrypted Cloudflare Worker environment secret — the key SHALL NOT be hardcoded in any source file.
4. IF the Groq API returns an error or does not respond within 10 seconds, THEN THE Service_Worker SHALL fall back to rule-based extraction without notifying the user, and SHALL log the failure internally for debugging purposes only.
5. THE Groq_Worker SHALL not log, store, or persist any conversation text received in a request.
6. WHERE the Pro feature flag is disabled, THE Service_Worker SHALL use rule-based extraction only and SHALL NOT send any data to the Groq_Worker.
7. IF the conversation text in a POST request exceeds 128,000 characters, THEN THE Groq_Worker SHALL reject the request and THE Service_Worker SHALL fall back to rule-based extraction.

---

### Requirement 13: Data Privacy

**User Story:** As a privacy-conscious user, I want my conversation data to stay on my device, so that I can trust Relay with sensitive work without worrying about data leaks.

#### Acceptance Criteria

1. THE Relay extension SHALL store all usage data (conversation text, timestamps, token counts, and user preferences) exclusively in `chrome.storage.local` — no usage data SHALL be transmitted to any external server.
2. THE Service_Worker SHALL not transmit conversation text to any external server except during an active, user-initiated Groq summarization call.
3. WHEN a Groq summarization call is made, THE Groq_Worker SHALL transmit only the conversation text required for summarization, SHALL NOT persist it beyond the duration of the HTTP request, and SHALL discard all transmitted data from memory upon receiving the response or after a maximum request timeout of 30 seconds, whichever occurs first.
4. IF a Groq summarization call fails or times out, THEN THE Groq_Worker SHALL discard the transmitted conversation text from memory and SHALL NOT retry the transmission without a new user-initiated action.
5. THE Relay extension SHALL not request Chrome permissions beyond those declared in `manifest.json`.
6. THE Relay extension SHALL not read, store, or transmit any data originating from pages that are not `chatgpt.com` or `claude.ai` — other internal data operations (such as reading stored usage records) SHALL remain permitted regardless of the active page.

---

### Requirement 14: Error Handling and Resilience

**User Story:** As a free-tier AI user, I want Relay to handle failures gracefully, so that a broken component never interrupts my workflow or leaves me without a fallback.

#### Acceptance Criteria

1. IF the remote `selectors.json` fetch fails, THEN THE Service_Worker SHALL fall back to the bundled local `config/selectors.json` without displaying an error to the user and without requiring user intervention.
2. IF the target platform tab fails to load within 30 seconds, THEN THE Service_Worker SHALL update the Popup with a `TAB_LOAD_TIMEOUT` error message.
3. IF the Injector fails to inject the Handoff_Prompt into the target platform's input field, THEN THE Injector SHALL attempt to copy the Handoff_Prompt to the clipboard and, only if the clipboard copy succeeds, display a browser notification informing the user that the prompt has been copied.
4. IF the Injector fails to inject the Handoff_Prompt and the subsequent clipboard copy also fails, THEN THE Injector SHALL display a browser notification informing the user that injection failed and instructing them to manually paste the prompt, and THE Popup SHALL display the Handoff_Prompt in a copyable text area.
5. IF the Groq API call fails or does not respond within 15 seconds, THEN THE Service_Worker SHALL fall back to rule-based extraction without displaying an error to the user.
6. IF the Claude SSE stream format changes and cannot be parsed, THEN THE Content_Script SHALL fall back to DOM-based limit detection as defined in Requirement 1.
7. IF both platforms are in `cooldown` status, THEN THE Popup SHALL display both reset timers showing minutes and seconds remaining (MM:SS format, updating every 1 second) and THE Content_Script SHALL display both timers in the Baton Pass UI floating card using the same format.

---

### Requirement 15: Session Context Delivery Path

**User Story:** As a free-tier AI user, I want the extracted conversation context to reliably travel from the source tab to the target tab, so that the handoff prompt is always available for injection regardless of tab lifecycle timing.

#### Acceptance Criteria

1. WHEN the Extractor completes context extraction, THE Content_Script SHALL send the Session_Context object to the Service_Worker via `chrome.runtime.sendMessage()`.
2. IF `chrome.runtime.sendMessage()` fails or receives no response within 5 seconds, THEN THE Content_Script SHALL retry delivery up to 3 times with a 1-second delay between attempts, and if all retries fail, SHALL notify the user via a browser notification that the handoff delivery failed.
3. WHEN the Service_Worker receives a Session_Context object, THE Service_Worker SHALL store it in `chrome.storage.local` under the key `relay_pending_handoff`.
4. WHEN the Injector is executed in the target tab, THE Injector SHALL read the Session_Context from `chrome.storage.local` under the key `relay_pending_handoff`.
5. WHEN the Injector has successfully injected the Handoff_Prompt or copied it to the clipboard, THE Injector SHALL delete the `relay_pending_handoff` key from `chrome.storage.local`.
6. IF the `relay_pending_handoff` key is not found, or the stored value is missing the `handoff_prompt` field or has a `handoff_prompt` that is an empty string, THEN THE Injector SHALL abort injection and notify the user via a browser notification that the handoff failed.
7. WHEN a new Baton Pass is initiated, THE Service_Worker SHALL overwrite any existing `relay_pending_handoff` value — only one pending handoff SHALL exist at a time.
8. IF the `relay_pending_handoff` entry has been stored for more than 10 minutes when the Injector reads it, THEN THE Injector SHALL treat the entry as expired, delete it from `chrome.storage.local`, and notify the user via a browser notification that the handoff expired.
