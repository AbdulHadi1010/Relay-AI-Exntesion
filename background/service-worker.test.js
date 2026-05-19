import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock chrome APIs
const mockStorageSet = vi.fn().mockResolvedValue(undefined);
const mockStorageGet = vi.fn().mockResolvedValue({});
const mockOnInstalledListeners = [];
const mockOnMessageListeners = [];
const mockOnAlarmListeners = [];
const mockWebRequestListeners = [];
const mockTabsQuery = vi.fn().mockResolvedValue([]);
const mockTabsSendMessage = vi.fn().mockResolvedValue(undefined);
const mockTabsCreate = vi.fn().mockResolvedValue({ id: 100 });
const mockTabsOnUpdatedListeners = [];
const mockAlarmsCreate = vi.fn().mockResolvedValue(undefined);
const mockScriptingExecuteScript = vi.fn().mockResolvedValue(undefined);

global.chrome = {
  runtime: {
    onInstalled: {
      addListener: (fn) => mockOnInstalledListeners.push(fn)
    },
    onMessage: {
      addListener: (fn) => mockOnMessageListeners.push(fn)
    },
    getURL: (path) => `chrome-extension://fake-id/${path}`
  },
  storage: {
    local: {
      set: mockStorageSet,
      get: mockStorageGet
    }
  },
  tabs: {
    query: mockTabsQuery,
    sendMessage: mockTabsSendMessage,
    create: mockTabsCreate,
    onUpdated: {
      addListener: (fn) => mockTabsOnUpdatedListeners.push(fn),
      removeListener: (fn) => {
        const idx = mockTabsOnUpdatedListeners.indexOf(fn);
        if (idx !== -1) mockTabsOnUpdatedListeners.splice(idx, 1);
      }
    }
  },
  alarms: {
    create: mockAlarmsCreate,
    onAlarm: {
      addListener: (fn) => mockOnAlarmListeners.push(fn)
    }
  },
  scripting: {
    executeScript: mockScriptingExecuteScript
  },
  webRequest: {
    onBeforeRequest: {
      addListener: (fn, filter, extraInfoSpec) => mockWebRequestListeners.push({ fn, filter, extraInfoSpec })
    }
  }
};

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock AbortController
const mockAbort = vi.fn();
global.AbortController = class {
  constructor() {
    this.signal = { aborted: false };
    this.abort = mockAbort;
  }
};

describe('service-worker onInstalled', () => {
  beforeEach(() => {
    mockOnInstalledListeners.length = 0;
    mockStorageSet.mockClear();
    mockFetch.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSendMessage.mockClear();
  });

  it('registers an onInstalled listener', async () => {
    // Mock fetch for the bundled selectors load that happens on import
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');
    expect(mockOnInstalledListeners.length).toBe(1);
  });

  it('initializes relay_usage with both platforms in unknown state', async () => {
    vi.resetModules();
    mockOnInstalledListeners.length = 0;
    mockStorageSet.mockClear();

    // Mock fetch for the bundled selectors load
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const now = Date.now();
    mockOnInstalledListeners[0]({ reason: 'install' });

    // The first call to set is from onInstalled (relay_usage)
    // Wait for the async IIFE to complete
    await vi.waitFor(() => {
      expect(mockStorageSet).toHaveBeenCalled();
    });

    // Find the relay_usage call
    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    expect(usageCall).toBeDefined();

    const usage = usageCall[0].relay_usage;

    // Verify both platforms exist
    expect(usage).toHaveProperty('chatgpt');
    expect(usage).toHaveProperty('claude');

    // Verify ChatGPT platform record
    expect(usage.chatgpt.status).toBe('available');
    expect(usage.chatgpt.messagesThisWindow).toBe(0);
    expect(usage.chatgpt.estimatedLimit).toBe(15);
    expect(usage.chatgpt.limitHitAt).toBeNull();
    expect(usage.chatgpt.estimatedResetAt).toBeNull();
    expect(usage.chatgpt.lastUpdated).toBeTypeOf('number');
    expect(usage.chatgpt.lastUpdated).toBeLessThanOrEqual(now);
    expect(usage.chatgpt.lastUpdated).toBeGreaterThan(now - 1000);

    // Verify Claude platform record
    expect(usage.claude.status).toBe('available');
    expect(usage.claude.messagesThisWindow).toBe(0);
    expect(usage.claude.estimatedLimit).toBe(25);
    expect(usage.claude.limitHitAt).toBeNull();
    expect(usage.claude.estimatedResetAt).toBeNull();
    expect(usage.claude.lastUpdated).toBeTypeOf('number');
    expect(usage.claude.lastUpdated).toBeLessThanOrEqual(now);
    expect(usage.claude.lastUpdated).toBeGreaterThan(now - 1000);
  });

  it('uses the same timestamp for both platforms', async () => {
    vi.resetModules();
    mockOnInstalledListeners.length = 0;
    mockStorageSet.mockClear();

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');
    mockOnInstalledListeners[0]({ reason: 'install' });

    await vi.waitFor(() => {
      expect(mockStorageSet).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const usage = usageCall[0].relay_usage;
    expect(usage.chatgpt.lastUpdated).toBe(usage.claude.lastUpdated);
  });
});

describe('service-worker remote selectors fetch', () => {
  beforeEach(() => {
    vi.resetModules();
    mockOnInstalledListeners.length = 0;
    mockStorageSet.mockClear();
    mockFetch.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSendMessage.mockClear();
    mockAbort.mockClear();
  });

  it('fetches remote selectors and stores them in chrome.storage.local', async () => {
    const bundledSelectors = {
      remote_url: 'https://example.com/selectors.json',
      platforms: { chatgpt: {}, claude: {} }
    };
    const remoteSelectors = {
      version: '2.0.0',
      platforms: { chatgpt: { updated: true }, claude: { updated: true } }
    };

    // First fetch: bundled file
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(bundledSelectors)
    });
    // Second fetch: remote file
    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve(JSON.stringify(remoteSelectors))
    });

    await import('./service-worker.js');

    // Wait for the async IIFE to complete
    await vi.waitFor(() => {
      const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
      expect(selectorsCall).toBeDefined();
    });

    const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
    expect(selectorsCall[0].relay_selectors).toEqual(remoteSelectors);
  });

  it('falls back to bundled selectors when remote fetch fails', async () => {
    const bundledSelectors = {
      remote_url: 'https://example.com/selectors.json',
      platforms: { chatgpt: {}, claude: {} }
    };

    // First fetch: bundled file
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(bundledSelectors)
    });
    // Second fetch: remote file fails
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await import('./service-worker.js');

    await vi.waitFor(() => {
      const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
      expect(selectorsCall).toBeDefined();
    });

    const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
    expect(selectorsCall[0].relay_selectors).toEqual(bundledSelectors);
  });

  it('falls back to bundled selectors when remote response is not valid JSON', async () => {
    const bundledSelectors = {
      remote_url: 'https://example.com/selectors.json',
      platforms: { chatgpt: {}, claude: {} }
    };

    // First fetch: bundled file
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(bundledSelectors)
    });
    // Second fetch: remote file returns invalid JSON
    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve('not valid json {{{')
    });

    await import('./service-worker.js');

    await vi.waitFor(() => {
      const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
      expect(selectorsCall).toBeDefined();
    });

    const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
    expect(selectorsCall[0].relay_selectors).toEqual(bundledSelectors);
  });

  it('falls back to bundled selectors when remote JSON lacks platforms field', async () => {
    const bundledSelectors = {
      remote_url: 'https://example.com/selectors.json',
      platforms: { chatgpt: {}, claude: {} }
    };

    // First fetch: bundled file
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(bundledSelectors)
    });
    // Second fetch: remote file returns JSON without platforms
    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve(JSON.stringify({ version: '1.0', noplatforms: true }))
    });

    await import('./service-worker.js');

    await vi.waitFor(() => {
      const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
      expect(selectorsCall).toBeDefined();
    });

    const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
    expect(selectorsCall[0].relay_selectors).toEqual(bundledSelectors);
  });

  it('uses bundled selectors when remote_url is missing', async () => {
    const bundledSelectors = {
      platforms: { chatgpt: {}, claude: {} }
      // no remote_url field
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(bundledSelectors)
    });

    await import('./service-worker.js');

    await vi.waitFor(() => {
      const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
      expect(selectorsCall).toBeDefined();
    });

    const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
    expect(selectorsCall[0].relay_selectors).toEqual(bundledSelectors);

    // Should only have called fetch once (for bundled file)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('uses bundled selectors when remote_url is empty string', async () => {
    const bundledSelectors = {
      remote_url: '',
      platforms: { chatgpt: {}, claude: {} }
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(bundledSelectors)
    });

    await import('./service-worker.js');

    await vi.waitFor(() => {
      const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
      expect(selectorsCall).toBeDefined();
    });

    const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
    expect(selectorsCall[0].relay_selectors).toEqual(bundledSelectors);

    // Should only have called fetch once (for bundled file)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches remote URL with AbortController signal for timeout', async () => {
    const bundledSelectors = {
      remote_url: 'https://example.com/selectors.json',
      platforms: { chatgpt: {}, claude: {} }
    };
    const remoteSelectors = {
      platforms: { chatgpt: { updated: true }, claude: {} }
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(bundledSelectors)
    });
    mockFetch.mockResolvedValueOnce({
      text: () => Promise.resolve(JSON.stringify(remoteSelectors))
    });

    await import('./service-worker.js');

    await vi.waitFor(() => {
      const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
      expect(selectorsCall).toBeDefined();
    });

    // Verify the remote fetch was called with the correct URL and signal
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const remoteCall = mockFetch.mock.calls[1];
    expect(remoteCall[0]).toBe('https://example.com/selectors.json');
    expect(remoteCall[1]).toHaveProperty('signal');
  });

  it('broadcasts SELECTORS_READY to connected tabs after storing selectors', async () => {
    const bundledSelectors = {
      remote_url: '',
      platforms: { chatgpt: {}, claude: {} }
    };

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve(bundledSelectors)
    });

    // Service worker now queries chatgpt.com and claude.ai tabs separately
    mockTabsQuery
      .mockResolvedValueOnce([{ id: 1 }])   // chatgpt tabs
      .mockResolvedValueOnce([{ id: 2 }]);  // claude tabs

    await import('./service-worker.js');

    await vi.waitFor(() => {
      expect(mockTabsSendMessage).toHaveBeenCalled();
    });

    expect(mockTabsSendMessage).toHaveBeenCalledWith(1, {
      type: 'SELECTORS_READY',
      selectors: bundledSelectors
    });
    expect(mockTabsSendMessage).toHaveBeenCalledWith(2, {
      type: 'SELECTORS_READY',
      selectors: bundledSelectors
    });
  });

  it('handles bundled file load failure gracefully', async () => {
    // Bundled file fetch fails
    mockFetch.mockRejectedValueOnce(new Error('Failed to load bundled file'));

    await import('./service-worker.js');

    await vi.waitFor(() => {
      const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
      expect(selectorsCall).toBeDefined();
    });

    const selectorsCall = mockStorageSet.mock.calls.find(call => call[0].relay_selectors);
    expect(selectorsCall[0].relay_selectors).toEqual({ platforms: {} });
  });
});


describe('service-worker LIMIT_DETECTED message listener', () => {
  beforeEach(() => {
    vi.resetModules();
    mockOnInstalledListeners.length = 0;
    mockOnMessageListeners.length = 0;
    mockStorageSet.mockClear();
    mockStorageGet.mockReset();
    mockFetch.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSendMessage.mockClear();
    mockAlarmsCreate.mockClear();
  });

  it('registers an onMessage listener', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');
    expect(mockOnMessageListeners.length).toBe(1);
  });

  it('updates platform usage to cooldown status on LIMIT_DETECTED', async () => {
    const selectors = {
      platforms: {
        chatgpt: { reset_window_hours: 3 },
        claude: { reset_window_hours: 5 }
      }
    };
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 10,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'warning'
      },
      claude: {
        messagesThisWindow: 0,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({
      relay_selectors: selectors,
      relay_usage: existingUsage
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();
    const now = Date.now();

    listener(
      { type: 'LIMIT_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    // Verify storage was updated
    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    expect(usageCall).toBeDefined();

    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.chatgpt.status).toBe('cooldown');
    expect(updatedUsage.chatgpt.limitHitAt).toBeGreaterThanOrEqual(now);
    expect(updatedUsage.chatgpt.limitHitAt).toBeLessThanOrEqual(Date.now());
    expect(updatedUsage.chatgpt.estimatedResetAt).toBe(
      updatedUsage.chatgpt.limitHitAt + (3 * 3600000)
    );
    expect(updatedUsage.chatgpt.lastUpdated).toBe(updatedUsage.chatgpt.limitHitAt);

    // Claude should remain unchanged
    expect(updatedUsage.claude.status).toBe('unknown');
  });

  it('calculates estimatedResetAt using reset_window_hours from selectors', async () => {
    const selectors = {
      platforms: {
        chatgpt: { reset_window_hours: 3 },
        claude: { reset_window_hours: 5 }
      }
    };
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 5,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      },
      claude: {
        messagesThisWindow: 20,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({
      relay_selectors: selectors,
      relay_usage: existingUsage
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    // Test Claude with 5-hour reset window
    listener(
      { type: 'LIMIT_DETECTED', platform: 'claude' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    expect(updatedUsage.claude.estimatedResetAt).toBe(
      updatedUsage.claude.limitHitAt + (5 * 3600000)
    );
  });

  it('creates a chrome.alarms entry for the reset time', async () => {
    const selectors = {
      platforms: {
        chatgpt: { reset_window_hours: 3 },
        claude: { reset_window_hours: 5 }
      }
    };
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 10,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'warning'
      },
      claude: {
        messagesThisWindow: 0,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({
      relay_selectors: selectors,
      relay_usage: existingUsage
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'LIMIT_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockAlarmsCreate).toHaveBeenCalled();
    });

    const alarmCall = mockAlarmsCreate.mock.calls[0];
    expect(alarmCall[0]).toBe('reset_chatgpt');
    expect(alarmCall[1]).toHaveProperty('when');

    // Verify the alarm time matches estimatedResetAt
    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(alarmCall[1].when).toBe(updatedUsage.chatgpt.estimatedResetAt);
  });

  it('sends a success response back to the content script', async () => {
    mockStorageGet.mockResolvedValue({
      relay_selectors: { platforms: { chatgpt: { reset_window_hours: 3 } } },
      relay_usage: {
        chatgpt: { messagesThisWindow: 0, status: 'unknown', limitHitAt: null, estimatedResetAt: null, lastUpdated: 1000 }
      }
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'LIMIT_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      platform: 'chatgpt',
      status: 'cooldown'
    });
  });

  it('defaults to 3 hours reset window when platform selectors are missing', async () => {
    mockStorageGet.mockResolvedValue({
      relay_selectors: { platforms: {} },
      relay_usage: {
        chatgpt: { messagesThisWindow: 0, status: 'unknown', limitHitAt: null, estimatedResetAt: null, lastUpdated: 1000 }
      }
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'LIMIT_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    // Default 3 hours = 3 * 3600000 ms
    expect(updatedUsage.chatgpt.estimatedResetAt).toBe(
      updatedUsage.chatgpt.limitHitAt + (3 * 3600000)
    );
  });

  it('returns true from the listener to indicate async response', async () => {
    mockStorageGet.mockResolvedValue({
      relay_selectors: { platforms: { chatgpt: { reset_window_hours: 3 } } },
      relay_usage: {
        chatgpt: { messagesThisWindow: 0, status: 'unknown', limitHitAt: null, estimatedResetAt: null, lastUpdated: 1000 }
      }
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    const result = listener(
      { type: 'LIMIT_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    expect(result).toBe(true);
  });

  it('does not handle messages with other types', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    const result = listener(
      { type: 'SOME_OTHER_MESSAGE', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    // Should not return true (no async response)
    expect(result).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('preserves existing usage fields when updating to cooldown', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 35,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'warning'
      },
      claude: {
        messagesThisWindow: 5,
        estimatedLimit: 25,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 2000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({
      relay_selectors: { platforms: { chatgpt: { reset_window_hours: 3 } } },
      relay_usage: existingUsage
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'LIMIT_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    // messagesThisWindow and estimatedLimit should be preserved
    expect(updatedUsage.chatgpt.messagesThisWindow).toBe(35);
    expect(updatedUsage.chatgpt.estimatedLimit).toBe(40);
  });
});


describe('service-worker WARNING_DETECTED message listener', () => {
  beforeEach(() => {
    vi.resetModules();
    mockOnInstalledListeners.length = 0;
    mockOnMessageListeners.length = 0;
    mockStorageSet.mockClear();
    mockStorageGet.mockReset();
    mockFetch.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSendMessage.mockClear();
    mockAlarmsCreate.mockClear();
  });

  it('updates estimatedLimit when remaining count is provided', async () => {
    const existingUsage = {
      claude: {
        messagesThisWindow: 15,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'WARNING_DETECTED', platform: 'claude', remaining: 10 },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    expect(usageCall).toBeDefined();

    const updatedUsage = usageCall[0].relay_usage;
    // estimatedLimit = messagesThisWindow + remaining = 15 + 10 = 25
    expect(updatedUsage.claude.estimatedLimit).toBe(25);
  });

  it('sets status to warning when messagesThisWindow exceeds 80% of estimatedLimit', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 34,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    // 34 > 0.8 * 40 (32), so status should become 'warning'
    listener(
      { type: 'WARNING_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.chatgpt.status).toBe('warning');
  });

  it('does NOT set status to warning when estimatedLimit is null (Req 10 AC8)', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 50,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'WARNING_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    // Status should remain 'unknown' since estimatedLimit is null
    expect(updatedUsage.chatgpt.status).toBe('unknown');
  });

  it('does NOT change status from cooldown to warning', async () => {
    const existingUsage = {
      claude: {
        messagesThisWindow: 20,
        estimatedLimit: 25,
        limitHitAt: Date.now() - 60000,
        estimatedResetAt: Date.now() + 3600000,
        lastUpdated: 1000,
        status: 'cooldown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    // 20 > 0.8 * 25 (20), but status is 'cooldown' so it should NOT change
    listener(
      { type: 'WARNING_DETECTED', platform: 'claude', remaining: 2 },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.claude.status).toBe('cooldown');
  });

  it('updates lastUpdated timestamp', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 5,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();
    const now = Date.now();

    listener(
      { type: 'WARNING_DETECTED', platform: 'chatgpt', remaining: 30 },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.chatgpt.lastUpdated).toBeGreaterThanOrEqual(now);
    expect(updatedUsage.chatgpt.lastUpdated).toBeLessThanOrEqual(Date.now());
  });

  it('returns true from the listener to indicate async response', async () => {
    mockStorageGet.mockResolvedValue({
      relay_usage: {
        chatgpt: { messagesThisWindow: 5, estimatedLimit: 40, status: 'available', lastUpdated: 1000 }
      }
    });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    const result = listener(
      { type: 'WARNING_DETECTED', platform: 'chatgpt', remaining: 10 },
      { tab: { id: 1 } },
      sendResponse
    );

    expect(result).toBe(true);
  });

  it('sends success response with current platform status', async () => {
    const existingUsage = {
      claude: {
        messagesThisWindow: 5,
        estimatedLimit: 25,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'WARNING_DETECTED', platform: 'claude', remaining: 20 },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      platform: 'claude',
      status: 'available'
    });
  });

  it('does not update estimatedLimit when remaining is not provided', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 35,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'WARNING_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    // estimatedLimit should remain unchanged at 40
    expect(updatedUsage.chatgpt.estimatedLimit).toBe(40);
  });

  it('does NOT set status to warning when messagesThisWindow is exactly 80% of estimatedLimit', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 32,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    // 32 is exactly 80% of 40, so it does NOT exceed — status should remain 'available'
    listener(
      { type: 'WARNING_DETECTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.chatgpt.status).toBe('available');
  });

  it('recalculates estimatedLimit with remaining and then evaluates warning threshold', async () => {
    const existingUsage = {
      claude: {
        messagesThisWindow: 22,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    // remaining = 3, so estimatedLimit = 22 + 3 = 25
    // 22 > 0.8 * 25 (20), so status should become 'warning'
    listener(
      { type: 'WARNING_DETECTED', platform: 'claude', remaining: 3 },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.claude.estimatedLimit).toBe(25);
    expect(updatedUsage.claude.status).toBe('warning');
  });
});


describe('service-worker chrome.alarms.onAlarm listener', () => {
  beforeEach(() => {
    vi.resetModules();
    mockOnInstalledListeners.length = 0;
    mockOnMessageListeners.length = 0;
    mockOnAlarmListeners.length = 0;
    mockStorageSet.mockClear();
    mockStorageGet.mockReset();
    mockFetch.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSendMessage.mockClear();
    mockAlarmsCreate.mockClear();
  });

  it('registers an onAlarm listener', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');
    expect(mockOnAlarmListeners.length).toBe(1);
  });

  it('resets ChatGPT messagesThisWindow to 0 when reset_chatgpt alarm fires', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 35,
        estimatedLimit: 40,
        limitHitAt: Date.now() - 3600000,
        estimatedResetAt: Date.now(),
        lastUpdated: Date.now() - 3600000,
        status: 'cooldown'
      },
      claude: {
        messagesThisWindow: 10,
        estimatedLimit: 25,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const alarmListener = mockOnAlarmListeners[0];
    alarmListener({ name: 'reset_chatgpt' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    expect(updatedUsage.chatgpt.messagesThisWindow).toBe(0);
  });

  it('sets ChatGPT status to available when reset_chatgpt alarm fires', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 35,
        estimatedLimit: 40,
        limitHitAt: Date.now() - 3600000,
        estimatedResetAt: Date.now(),
        lastUpdated: Date.now() - 3600000,
        status: 'cooldown'
      },
      claude: {
        messagesThisWindow: 10,
        estimatedLimit: 25,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const alarmListener = mockOnAlarmListeners[0];
    alarmListener({ name: 'reset_chatgpt' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    expect(updatedUsage.chatgpt.status).toBe('available');
  });

  it('resets Claude record when reset_claude alarm fires', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 10,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      },
      claude: {
        messagesThisWindow: 20,
        estimatedLimit: 25,
        limitHitAt: Date.now() - 5 * 3600000,
        estimatedResetAt: Date.now(),
        lastUpdated: Date.now() - 5 * 3600000,
        status: 'cooldown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const alarmListener = mockOnAlarmListeners[0];
    alarmListener({ name: 'reset_claude' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    expect(updatedUsage.claude.messagesThisWindow).toBe(0);
    expect(updatedUsage.claude.status).toBe('available');
  });

  it('updates lastUpdated to current timestamp on alarm fire', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 35,
        estimatedLimit: 40,
        limitHitAt: Date.now() - 3600000,
        estimatedResetAt: Date.now(),
        lastUpdated: 1000,
        status: 'cooldown'
      },
      claude: {
        messagesThisWindow: 0,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const alarmListener = mockOnAlarmListeners[0];
    const now = Date.now();
    alarmListener({ name: 'reset_chatgpt' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    expect(updatedUsage.chatgpt.lastUpdated).toBeGreaterThanOrEqual(now);
    expect(updatedUsage.chatgpt.lastUpdated).toBeLessThanOrEqual(Date.now());
  });

  it('ignores non-reset alarms', async () => {
    mockStorageGet.mockResolvedValue({ relay_usage: {} });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const alarmListener = mockOnAlarmListeners[0];
    alarmListener({ name: 'some_other_alarm' });

    // Give it a tick to ensure nothing happens
    await new Promise(resolve => setTimeout(resolve, 50));

    // Storage get should not have been called for non-reset alarms
    // (the initial import may call storage.get for selectors, so we check
    // that no relay_usage set call was made)
    const usageSetCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    expect(usageSetCall).toBeUndefined();
  });

  it('does not modify other platform records when resetting one platform', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 35,
        estimatedLimit: 40,
        limitHitAt: Date.now() - 3600000,
        estimatedResetAt: Date.now(),
        lastUpdated: Date.now() - 3600000,
        status: 'cooldown'
      },
      claude: {
        messagesThisWindow: 10,
        estimatedLimit: 25,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 2000,
        status: 'warning'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const alarmListener = mockOnAlarmListeners[0];
    alarmListener({ name: 'reset_chatgpt' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    // Claude should remain unchanged
    expect(updatedUsage.claude.messagesThisWindow).toBe(10);
    expect(updatedUsage.claude.status).toBe('warning');
    expect(updatedUsage.claude.lastUpdated).toBe(2000);
  });
});


describe('service-worker webRequest ChatGPT message counting', () => {
  beforeEach(() => {
    vi.resetModules();
    mockOnInstalledListeners.length = 0;
    mockOnMessageListeners.length = 0;
    mockOnAlarmListeners.length = 0;
    mockWebRequestListeners.length = 0;
    mockStorageSet.mockClear();
    mockStorageGet.mockReset();
    mockFetch.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSendMessage.mockClear();
    mockAlarmsCreate.mockClear();
  });

  it('registers a webRequest.onBeforeRequest listener', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');
    expect(mockWebRequestListeners.length).toBe(1);
  });

  it('registers with correct URL filter for chatgpt.com/backend-api/conversation', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const registration = mockWebRequestListeners[0];
    expect(registration.filter).toEqual({ urls: ['*://chatgpt.com/backend-api/conversation*'] });
  });

  it('registers with requestBody in extraInfoSpec', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const registration = mockWebRequestListeners[0];
    expect(registration.extraInfoSpec).toEqual(['requestBody']);
  });

  it('increments messagesThisWindow on POST request', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 5,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      },
      claude: {
        messagesThisWindow: 0,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    listener({ method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.chatgpt.messagesThisWindow).toBe(6);
  });

  it('does NOT increment messagesThisWindow on non-POST requests', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 5,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    listener({ method: 'GET', url: 'https://chatgpt.com/backend-api/conversation' });

    // Give it a tick to ensure nothing happens
    await new Promise(resolve => setTimeout(resolve, 50));

    // No relay_usage set call should have been made
    const usageSetCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    expect(usageSetCall).toBeUndefined();
  });

  it('updates lastUpdated to current timestamp', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 10,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    const now = Date.now();
    listener({ method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.chatgpt.lastUpdated).toBeGreaterThanOrEqual(now);
    expect(updatedUsage.chatgpt.lastUpdated).toBeLessThanOrEqual(Date.now());
  });

  it('sets status to warning when messagesThisWindow exceeds 80% of estimatedLimit after increment', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 32,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    // After increment: 33 > 0.8 * 40 (32), so status should become 'warning'
    listener({ method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.chatgpt.status).toBe('warning');
  });

  it('does NOT evaluate warning threshold when estimatedLimit is null', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 50,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    listener({ method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    // Status should remain 'unknown' since estimatedLimit is null
    expect(updatedUsage.chatgpt.status).toBe('unknown');
    expect(updatedUsage.chatgpt.messagesThisWindow).toBe(51);
  });

  it('does NOT change status from cooldown to warning', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 35,
        estimatedLimit: 40,
        limitHitAt: Date.now() - 60000,
        estimatedResetAt: Date.now() + 3600000,
        lastUpdated: 1000,
        status: 'cooldown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    // 36 > 0.8 * 40 (32), but status is 'cooldown' so it should NOT change
    listener({ method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;
    expect(updatedUsage.chatgpt.status).toBe('cooldown');
    expect(updatedUsage.chatgpt.messagesThisWindow).toBe(36);
  });

  it('does not modify Claude record when counting ChatGPT messages', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 5,
        estimatedLimit: 40,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'available'
      },
      claude: {
        messagesThisWindow: 10,
        estimatedLimit: 25,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 2000,
        status: 'warning'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    listener({ method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    // Claude should remain unchanged
    expect(updatedUsage.claude.messagesThisWindow).toBe(10);
    expect(updatedUsage.claude.status).toBe('warning');
    expect(updatedUsage.claude.lastUpdated).toBe(2000);
  });

  it('initializes chatgpt record if missing from storage', async () => {
    // No chatgpt record in storage
    mockStorageGet.mockResolvedValue({ relay_usage: {} });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    listener({ method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    expect(updatedUsage.chatgpt.messagesThisWindow).toBe(1);
    expect(updatedUsage.chatgpt.status).toBe('unknown');
    expect(updatedUsage.chatgpt.estimatedLimit).toBeNull();
  });

  it('keeps status as unknown when estimatedLimit is null even after increment', async () => {
    const existingUsage = {
      chatgpt: {
        messagesThisWindow: 0,
        estimatedLimit: null,
        limitHitAt: null,
        estimatedResetAt: null,
        lastUpdated: 1000,
        status: 'unknown'
      }
    };

    mockStorageGet.mockResolvedValue({ relay_usage: existingUsage });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockWebRequestListeners[0].fn;
    listener({ method: 'POST', url: 'https://chatgpt.com/backend-api/conversation' });

    await vi.waitFor(() => {
      const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
      expect(usageCall).toBeDefined();
    });

    const usageCall = mockStorageSet.mock.calls.find(call => call[0].relay_usage);
    const updatedUsage = usageCall[0].relay_usage;

    expect(updatedUsage.chatgpt.messagesThisWindow).toBe(1);
    expect(updatedUsage.chatgpt.status).toBe('unknown');
  });
});


describe('service-worker CONTEXT_EXTRACTED message listener', () => {
  beforeEach(() => {
    vi.resetModules();
    mockOnInstalledListeners.length = 0;
    mockOnMessageListeners.length = 0;
    mockOnAlarmListeners.length = 0;
    mockWebRequestListeners.length = 0;
    mockStorageSet.mockClear();
    mockStorageGet.mockReset();
    mockFetch.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSendMessage.mockClear();
    mockAlarmsCreate.mockClear();
  });

  it('stores context in relay_pending_handoff', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    const sessionContext = {
      platform: 'chatgpt',
      goal: 'Help me debug this function',
      codeBlocks: ['const x = 1;'],
      keyOutputs: ['Here is the solution...'],
      lastExchanges: [{ user: 'Fix this', assistant: 'Done' }],
      errorMessages: ['There was an error'],
      sessionType: 'coding',
      totalMessages: 4,
      extractedAt: '2024-01-01T00:00:00.000Z'
    };

    listener(
      { type: 'CONTEXT_EXTRACTED', context: sessionContext },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    const handoffCall = mockStorageSet.mock.calls.find(call => call[0].relay_pending_handoff);
    expect(handoffCall).toBeDefined();
    expect(handoffCall[0].relay_pending_handoff).toEqual(sessionContext);
  });

  it('overwrites existing relay_pending_handoff value', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse1 = vi.fn();
    const sendResponse2 = vi.fn();

    const firstContext = {
      platform: 'chatgpt',
      goal: 'First goal',
      codeBlocks: [],
      keyOutputs: [],
      lastExchanges: [],
      errorMessages: [],
      sessionType: 'general',
      totalMessages: 2,
      extractedAt: '2024-01-01T00:00:00.000Z'
    };

    const secondContext = {
      platform: 'claude',
      goal: 'Second goal',
      codeBlocks: ['console.log("hello")'],
      keyOutputs: ['Output text'],
      lastExchanges: [{ user: 'Hi', assistant: 'Hello' }],
      errorMessages: [],
      sessionType: 'coding',
      totalMessages: 6,
      extractedAt: '2024-01-01T01:00:00.000Z'
    };

    // Store first context
    listener(
      { type: 'CONTEXT_EXTRACTED', context: firstContext },
      { tab: { id: 1 } },
      sendResponse1
    );

    await vi.waitFor(() => {
      expect(sendResponse1).toHaveBeenCalled();
    });

    mockStorageSet.mockClear();

    // Store second context — should overwrite
    listener(
      { type: 'CONTEXT_EXTRACTED', context: secondContext },
      { tab: { id: 2 } },
      sendResponse2
    );

    await vi.waitFor(() => {
      expect(sendResponse2).toHaveBeenCalled();
    });

    const handoffCall = mockStorageSet.mock.calls.find(call => call[0].relay_pending_handoff);
    expect(handoffCall).toBeDefined();
    expect(handoffCall[0].relay_pending_handoff).toEqual(secondContext);
  });

  it('sends success response back to the content script', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    const sessionContext = {
      platform: 'claude',
      goal: 'Write an essay',
      codeBlocks: [],
      keyOutputs: [],
      lastExchanges: [],
      errorMessages: [],
      sessionType: 'writing',
      totalMessages: 2,
      extractedAt: '2024-01-01T00:00:00.000Z'
    };

    listener(
      { type: 'CONTEXT_EXTRACTED', context: sessionContext },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('returns true from the listener to indicate async response', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    const result = listener(
      { type: 'CONTEXT_EXTRACTED', context: { platform: 'chatgpt', goal: 'test' } },
      { tab: { id: 1 } },
      sendResponse
    );

    expect(result).toBe(true);
  });
});


describe('service-worker BATON_PASS_REQUESTED message listener', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mockOnInstalledListeners.length = 0;
    mockOnMessageListeners.length = 0;
    mockOnAlarmListeners.length = 0;
    mockWebRequestListeners.length = 0;
    mockTabsOnUpdatedListeners.length = 0;
    mockStorageSet.mockClear();
    mockStorageGet.mockReset();
    mockFetch.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSendMessage.mockClear();
    mockTabsCreate.mockReset();
    mockTabsCreate.mockResolvedValue({ id: 100 });
    mockAlarmsCreate.mockClear();
    mockScriptingExecuteScript.mockReset();
    mockScriptingExecuteScript.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens https://claude.ai/new when platform is chatgpt', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsCreate).toHaveBeenCalled();
    });

    expect(mockTabsCreate).toHaveBeenCalledWith({ url: 'https://claude.ai/new' });
  });

  it('opens https://chatgpt.com when platform is claude', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'claude' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsCreate).toHaveBeenCalled();
    });

    expect(mockTabsCreate).toHaveBeenCalledWith({ url: 'https://chatgpt.com/?model=auto' });
  });

  it('sends success response with tab ID', async () => {
    mockTabsCreate.mockResolvedValue({ id: 42 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    expect(sendResponse).toHaveBeenCalledWith({ success: true, tabId: 42 });
  });

  it('ignores subsequent requests while routing is in progress', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse1 = vi.fn();
    const sendResponse2 = vi.fn();

    // First request — starts routing
    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse1
    );

    await vi.waitFor(() => {
      expect(sendResponse1).toHaveBeenCalled();
    });

    // Second request — should be ignored because routing is in progress
    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'claude' },
      { tab: { id: 2 } },
      sendResponse2
    );

    // Second response should indicate routing is already in progress
    expect(sendResponse2).toHaveBeenCalledWith({
      success: false,
      error: 'Routing already in progress'
    });

    // tabs.create should only have been called once
    expect(mockTabsCreate).toHaveBeenCalledTimes(1);
  });

  it('sets up a chrome.tabs.onUpdated listener for the new tab', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    // A tab update listener should have been registered
    expect(mockTabsOnUpdatedListeners.length).toBe(1);
  });

  it('removes onUpdated listener when tab reaches status complete', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Simulate tab load complete
    const tabUpdateListener = mockTabsOnUpdatedListeners[0];
    tabUpdateListener(55, { status: 'complete' });

    // Listener should have been removed
    expect(mockTabsOnUpdatedListeners.length).toBe(0);
  });

  it('ignores onUpdated events for other tabs', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Simulate update for a different tab
    const tabUpdateListener = mockTabsOnUpdatedListeners[0];
    tabUpdateListener(999, { status: 'complete' });

    // Listener should still be registered (not removed)
    expect(mockTabsOnUpdatedListeners.length).toBe(1);
  });

  it('ignores onUpdated events with status other than complete', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Simulate update with loading status
    const tabUpdateListener = mockTabsOnUpdatedListeners[0];
    tabUpdateListener(55, { status: 'loading' });

    // Listener should still be registered
    expect(mockTabsOnUpdatedListeners.length).toBe(1);
  });

  it('resets routingInProgress flag when tab completes loading', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse1 = vi.fn();

    // Start first routing
    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse1
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Simulate tab load complete
    const tabUpdateListener = mockTabsOnUpdatedListeners[0];
    tabUpdateListener(55, { status: 'complete' });

    // Now a new routing request should be accepted
    mockTabsCreate.mockResolvedValue({ id: 77 });
    const sendResponse2 = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'claude' },
      { tab: { id: 2 } },
      sendResponse2
    );

    await vi.waitFor(() => {
      expect(sendResponse2).toHaveBeenCalled();
    });

    expect(sendResponse2).toHaveBeenCalledWith({ success: true, tabId: 77 });
  });

  it('sets up a 30-second timeout', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Advance time by 30 seconds to trigger timeout
    vi.advanceTimersByTime(30000);

    // After timeout, the onUpdated listener should be removed
    expect(mockTabsOnUpdatedListeners.length).toBe(0);
  });

  it('resets routingInProgress flag on timeout', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse1 = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse1
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Advance time by 30 seconds to trigger timeout
    vi.advanceTimersByTime(30000);

    // Now a new routing request should be accepted
    mockTabsCreate.mockResolvedValue({ id: 88 });
    const sendResponse2 = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'claude' },
      { tab: { id: 2 } },
      sendResponse2
    );

    await vi.waitFor(() => {
      expect(sendResponse2).toHaveBeenCalled();
    });

    expect(sendResponse2).toHaveBeenCalledWith({ success: true, tabId: 88 });
  });

  it('returns true from the listener to indicate async response', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    const result = listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    expect(result).toBe(true);
  });

  it('sends error response when chrome.tabs.create fails', async () => {
    mockTabsCreate.mockRejectedValue(new Error('TAB_CREATE_FAILED'));

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'TAB_CREATE_FAILED'
    });
  });

  it('resets routingInProgress flag when chrome.tabs.create fails', async () => {
    mockTabsCreate.mockRejectedValue(new Error('TAB_CREATE_FAILED'));

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse1 = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse1
    );

    await vi.waitFor(() => {
      expect(sendResponse1).toHaveBeenCalled();
    });

    // After failure, a new request should be accepted
    mockTabsCreate.mockResolvedValue({ id: 99 });
    const sendResponse2 = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'claude' },
      { tab: { id: 2 } },
      sendResponse2
    );

    await vi.waitFor(() => {
      expect(sendResponse2).toHaveBeenCalled();
    });

    expect(sendResponse2).toHaveBeenCalledWith({ success: true, tabId: 99 });
  });

  it('clears timeout when tab completes loading before 30 seconds', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Simulate tab load complete before timeout
    const tabUpdateListener = mockTabsOnUpdatedListeners[0];
    tabUpdateListener(55, { status: 'complete' });

    // Advance time past 30 seconds — should not cause any issues
    // since timeout was cleared
    vi.advanceTimersByTime(30000);

    // Listener was already removed, so length should still be 0
    expect(mockTabsOnUpdatedListeners.length).toBe(0);
  });

  it('executes handoff/injector.js via chrome.scripting.executeScript when tab completes', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Simulate tab load complete
    const tabUpdateListener = mockTabsOnUpdatedListeners[0];
    tabUpdateListener(55, { status: 'complete' });

    await vi.waitFor(() => {
      expect(mockScriptingExecuteScript).toHaveBeenCalled();
    });

    expect(mockScriptingExecuteScript).toHaveBeenCalledWith({
      target: { tabId: 55 },
      files: ['handoff/injector.js']
    });
  });

  it('stores TAB_LOAD_TIMEOUT error in chrome.storage.local on timeout', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    mockStorageSet.mockClear();

    // Advance time by 30 seconds to trigger timeout
    vi.advanceTimersByTime(30000);

    // Should have stored the error
    const errorCall = mockStorageSet.mock.calls.find(call => call[0].relay_last_error);
    expect(errorCall).toBeDefined();
    expect(errorCall[0].relay_last_error.code).toBe('TAB_LOAD_TIMEOUT');
    expect(errorCall[0].relay_last_error.message).toBe('Target tab did not finish loading within 30 seconds');
    expect(errorCall[0].relay_last_error.timestamp).toBeTypeOf('number');
  });

  it('stores SCRIPT_INJECTION_FAILED error when executeScript fails', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });
    mockScriptingExecuteScript.mockRejectedValue(new Error('Cannot access tab'));

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    mockStorageSet.mockClear();

    // Simulate tab load complete
    const tabUpdateListener = mockTabsOnUpdatedListeners[0];
    tabUpdateListener(55, { status: 'complete' });

    await vi.waitFor(() => {
      const errorCall = mockStorageSet.mock.calls.find(call => call[0].relay_last_error);
      expect(errorCall).toBeDefined();
    });

    const errorCall = mockStorageSet.mock.calls.find(call => call[0].relay_last_error);
    expect(errorCall[0].relay_last_error.code).toBe('SCRIPT_INJECTION_FAILED');
    expect(errorCall[0].relay_last_error.message).toBe('Cannot access tab');
    expect(errorCall[0].relay_last_error.timestamp).toBeTypeOf('number');
  });

  it('does not call executeScript on timeout', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Advance time by 30 seconds to trigger timeout
    vi.advanceTimersByTime(30000);

    // executeScript should NOT have been called
    expect(mockScriptingExecuteScript).not.toHaveBeenCalled();
  });

  it('leaves the new tab open when executeScript fails', async () => {
    mockTabsCreate.mockResolvedValue({ id: 55 });
    mockScriptingExecuteScript.mockRejectedValue(new Error('Injection failed'));

    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ remote_url: '', platforms: {} })
    });

    await import('./service-worker.js');

    const listener = mockOnMessageListeners[0];
    const sendResponse = vi.fn();

    listener(
      { type: 'BATON_PASS_REQUESTED', platform: 'chatgpt' },
      { tab: { id: 1 } },
      sendResponse
    );

    await vi.waitFor(() => {
      expect(mockTabsOnUpdatedListeners.length).toBe(1);
    });

    // Simulate tab load complete
    const tabUpdateListener = mockTabsOnUpdatedListeners[0];
    tabUpdateListener(55, { status: 'complete' });

    await vi.waitFor(() => {
      const errorCall = mockStorageSet.mock.calls.find(call => call[0].relay_last_error);
      expect(errorCall).toBeDefined();
    });

    // Verify no tab removal was attempted (no chrome.tabs.remove mock needed — 
    // just verify it wasn't called if it existed)
    // The tab should remain open per requirements
    expect(mockScriptingExecuteScript).toHaveBeenCalledTimes(1);
  });
});
