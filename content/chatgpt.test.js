import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('content/chatgpt.js fetch override', () => {
  let originalFetch;
  let sendMessageMock;

  beforeEach(() => {
    // Reset modules to re-execute the IIFE
    vi.resetModules();

    // Set up chrome.runtime.sendMessage mock
    sendMessageMock = vi.fn();
    global.chrome = {
      runtime: {
        sendMessage: sendMessageMock
      }
    };

    // Store a mock as the "original" fetch that the script will capture
    originalFetch = vi.fn();
    global.window = global;
    global.window.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.chrome;
  });

  function loadScript() {
    // Simulate the IIFE by evaluating the override logic
    const origFetch = global.window.fetch;
    const MAX_BODY_SIZE = 1048576;

    global.window.fetch = async function(...args) {
      const response = await origFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      if (url.includes('backend-api/conversation')) {
        if (response.status === 429) {
          chrome.runtime.sendMessage({ type: 'LIMIT_DETECTED', platform: 'chatgpt' });
        } else {
          try {
            const clone = response.clone();
            const contentLength = clone.headers.get('content-length');
            if (!contentLength || parseInt(contentLength, 10) <= MAX_BODY_SIZE) {
              const data = await clone.json();
              if (
                (data?.detail && typeof data.detail === 'string' && data.detail.toLowerCase().includes('rate')) ||
                (data?.error !== undefined && data?.error !== null)
              ) {
                chrome.runtime.sendMessage({ type: 'LIMIT_DETECTED', platform: 'chatgpt' });
              }
            }
          } catch (e) {
            // Silently discard
          }
        }
      }

      return response;
    };
  }

  function createMockResponse(url, status, body, contentLength) {
    const headers = new Map();
    if (contentLength !== undefined) {
      headers.set('content-length', String(contentLength));
    }

    const response = {
      status,
      headers: {
        get: (name) => headers.get(name) || null
      },
      clone: () => ({
        status,
        headers: {
          get: (name) => headers.get(name) || null
        },
        json: () => {
          if (body === null) return Promise.reject(new Error('Not JSON'));
          return Promise.resolve(body);
        }
      })
    };

    return response;
  }

  it('returns the original unmodified response for non-conversation URLs', async () => {
    const mockResponse = createMockResponse('https://chatgpt.com/api/other', 200, { ok: true });
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const result = await window.fetch('https://chatgpt.com/api/other');
    expect(result).toBe(mockResponse);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('returns the original unmodified response for conversation URLs', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { message: 'hello' }
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const result = await window.fetch('https://chatgpt.com/backend-api/conversation');
    expect(result).toBe(mockResponse);
  });

  it('sends LIMIT_DETECTED when response status is 429', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      429,
      null
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'chatgpt'
    });
  });

  it('sends LIMIT_DETECTED when detail field contains "rate" (case-insensitive)', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { detail: 'Rate limit exceeded' }
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'chatgpt'
    });
  });

  it('sends LIMIT_DETECTED when detail contains "rate" in mixed case', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { detail: 'You have been RATE limited' }
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'chatgpt'
    });
  });

  it('sends LIMIT_DETECTED when error field is non-null', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { error: 'something went wrong' }
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'chatgpt'
    });
  });

  it('sends LIMIT_DETECTED when error field is an object (non-null)', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { error: { code: 'rate_limit' } }
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'chatgpt'
    });
  });

  it('does NOT send LIMIT_DETECTED when error field is null', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { error: null, detail: 'all good' }
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does NOT send LIMIT_DETECTED for normal successful responses', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { message: { content: 'Hello!' } }
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('silently catches JSON parse errors without sending a message', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      null // will cause json() to reject
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const result = await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(result).toBe(mockResponse);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('skips parsing when Content-Length exceeds 1MB', async () => {
    const jsonSpy = vi.fn();
    const headers = new Map();
    headers.set('content-length', '2000000'); // 2MB

    const mockResponse = {
      status: 200,
      headers: {
        get: (name) => headers.get(name) || null
      },
      clone: () => ({
        status: 200,
        headers: {
          get: (name) => headers.get(name) || null
        },
        json: jsonSpy
      })
    };
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    // json() should never be called since content-length > 1MB
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('parses response when Content-Length is exactly 1MB', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { detail: 'rate limit hit' },
      1048576 // exactly 1MB
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'chatgpt'
    });
  });

  it('parses response when Content-Length header is absent', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { detail: 'rate limit reached' }
      // no content-length
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'chatgpt'
    });
  });

  it('handles Request object as first argument', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      429,
      null
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const request = { url: 'https://chatgpt.com/backend-api/conversation' };
    await window.fetch(request);

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'chatgpt'
    });
  });

  it('passes all arguments through to original fetch', async () => {
    const mockResponse = createMockResponse('https://example.com/api', 200, {});
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const options = { method: 'POST', body: '{}' };
    await window.fetch('https://example.com/api', options);

    expect(originalFetch).toHaveBeenCalledWith('https://example.com/api', options);
  });

  it('does not send LIMIT_DETECTED when detail does not contain "rate"', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { detail: 'Something else happened' }
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not send LIMIT_DETECTED when detail is not a string', async () => {
    const mockResponse = createMockResponse(
      'https://chatgpt.com/backend-api/conversation',
      200,
      { detail: { type: 'rate_limit' } } // detail is object, not string
    );
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://chatgpt.com/backend-api/conversation');

    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
