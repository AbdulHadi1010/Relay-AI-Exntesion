'use strict';

const statusLine = document.getElementById('status-line');

function showStatus(text, type = '') {
  statusLine.textContent = text;
  statusLine.className = 'status-line' + (type ? ' ' + type : '');
}

/**
 * Handle platform button click.
 * Sends a RELAY_HANDOFF_REQUEST to the service worker which handles the entire flow.
 * The popup can close — the service worker continues in the background.
 */
async function handlePlatformClick(targetPlatform, targetUrl) {
  showStatus('Starting handoff...', 'loading');

  try {
    // Get the current active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!activeTab) {
      chrome.tabs.create({ url: targetUrl });
      window.close();
      return;
    }

    const activeUrl = activeTab.url || '';
    const isOnAIPlatform = activeUrl.includes('chatgpt.com') ||
                           activeUrl.includes('claude.ai') ||
                           activeUrl.includes('gemini.google.com') ||
                           activeUrl.includes('grok.com');

    if (!isOnAIPlatform) {
      chrome.tabs.create({ url: targetUrl });
      window.close();
      return;
    }

    // Determine source platform
    let sourcePlatform = 'unknown';
    if (activeUrl.includes('chatgpt.com')) sourcePlatform = 'chatgpt';
    else if (activeUrl.includes('claude.ai')) sourcePlatform = 'claude';
    else if (activeUrl.includes('gemini.google.com')) sourcePlatform = 'gemini';
    else if (activeUrl.includes('grok.com')) sourcePlatform = 'grok';

    if (sourcePlatform === targetPlatform) {
      chrome.tabs.create({ url: targetUrl });
      window.close();
      return;
    }

    // Send the entire handoff job to the service worker
    // The service worker handles: extract → summarize → store → open → inject
    chrome.runtime.sendMessage({
      type: 'RELAY_FULL_HANDOFF',
      sourceTabId: activeTab.id,
      sourcePlatform,
      targetPlatform
    });

    showStatus(`Handing off to ${targetPlatform}...`, 'loading');
    // Close popup after a short delay — service worker continues the work
    setTimeout(() => window.close(), 800);

  } catch (e) {
    chrome.tabs.create({ url: targetUrl });
    window.close();
  }
}

// Attach click handlers
document.querySelectorAll('.platform-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const platform = btn.dataset.platform;
    const url = btn.dataset.url;
    handlePlatformClick(platform, url);
  });
});

showStatus('Click a platform to hand off or start fresh');
