# Relay Privacy Policy

**Last Updated:** June 2025

## Overview

Relay is a Chrome extension that helps you seamlessly hand off AI conversations between platforms (ChatGPT, Claude, Gemini, and Grok) when you hit usage limits. We are committed to protecting your privacy and being transparent about how your data is handled.

## What Data Is Collected

Relay collects only minimal operational data required for the extension to function:

- **Message counts per platform** — tracks how many messages you've sent to each AI platform during the current session
- **Cooldown timers** — records when rate limits are hit so the extension knows when a platform becomes available again

**We do NOT collect:**
- Conversation content or message text
- Personal information or identifiers
- Browsing history
- Keystroke data
- Any form of analytics or telemetry

## Where Data Is Stored

All data is stored **exclusively in `chrome.storage.local`** on your device. No data is transmitted to any server owned or operated by Relay. Your usage counts and cooldown timers never leave your browser.

## What Leaves Your Device

The only scenario where any data leaves your device:

- **Optional AI Summarization (Pro feature):** If you choose to use the conversation summarization feature, the current conversation text is sent to the Groq API for processing. This transmission is:
  - **Ephemeral** — text is sent only for real-time inference and is not stored by Groq
  - **User-initiated** — only happens when you explicitly trigger summarization
  - **Optional** — the core handoff functionality works entirely offline without this feature

## Third-Party Services

| Service | Purpose | When Used |
|---------|---------|-----------|
| Groq API | Conversation summarization | Only when Pro summarization is explicitly triggered by the user |

No other third-party services are used. There are no analytics platforms, no ad networks, and no tracking pixels.

## No Analytics, No Tracking, No Ads

Relay does not:
- Use Google Analytics or any analytics service
- Track your behavior across websites
- Display advertisements
- Sell or share any data with third parties
- Use cookies or fingerprinting

## Data Retention

Since all data is stored locally in your browser:
- Data persists only as long as the extension is installed
- Uninstalling the extension removes all stored data
- You can clear extension data at any time through Chrome's extension settings

## Changes to This Policy

If we make changes to this privacy policy, we will update the "Last Updated" date at the top of this document and notify users through the extension update notes.

## Contact

If you have questions or concerns about this privacy policy, please contact us:

- **Email:** [your-email@example.com]
- **GitHub Issues:** [repository-url/issues]

---

*This privacy policy applies to the Relay Chrome Extension available on the Chrome Web Store.*
