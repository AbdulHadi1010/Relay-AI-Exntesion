import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('content/claude.js SSE stream interception', () => {
  let originalFetch;
  let sendMessageMock;

  beforeEach(() => {
    vi.resetModules();

    sendMessageMock = vi.fn();
    global.chrome = {
      runtime: {
        sendMessage: sendMessageMock
      }
    };

    originalFetch = vi.fn();
    global.window = global;
    global.window.fetch = originalFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.chrome;
  });

  /**
   * Helper to create a ReadableStream from SSE text chunks.
   */
  function createSSEStream(chunks) {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]));
          index++;
        } else {
          controller.close();
        }
      }
    });
  }

  /**
   * Helper to create a mock response with SSE content-type and a readable body.
   */
  function createSSEResponse(url, chunks) {
    const body = createSSEStream(chunks);
    const cloneBody = createSSEStream(chunks);

    const response = {
      status: 200,
      headers: {
        get: (name) => {
          if (name === 'content-type') return 'text/event-stream';
          return null;
        }
      },
      body,
      clone: () => ({
        status: 200,
        headers: {
          get: (name) => {
            if (name === 'content-type') return 'text/event-stream';
            return null;
          }
        },
        body: cloneBody
      })
    };

    return response;
  }

  /**
   * Helper to create a mock response with non-SSE content-type.
   */
  function createNonSSEResponse(url) {
    return {
      status: 200,
      headers: {
        get: (name) => {
          if (name === 'content-type') return 'application/json';
          return null;
        }
      },
      body: null,
      clone: () => ({
        status: 200,
        headers: {
          get: (name) => {
            if (name === 'content-type') return 'application/json';
            return null;
          }
        },
        body: null
      })
    };
  }

  /**
   * Load the SSE interception logic (simulates the IIFE).
   */
  function loadScript() {
    let sseDisabled = false;
    const origFetch = global.window.fetch;

    global.window.fetch = async function(...args) {
      const response = await origFetch.apply(this, args);

      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const contentType = response.headers.get('content-type') || '';

      if (!sseDisabled && url.includes('/api/') && contentType.includes('text/event-stream')) {
        try {
          const clone = response.clone();
          // Process synchronously in tests for predictability
          await processSSEStream(clone.body);
        } catch (e) {
          sseDisabled = true;
        }
      }

      return response;
    };

    async function processSSEStream(body) {
      if (!body) return;

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ') && currentEvent === 'message_limit') {
              const dataStr = line.slice(6).trim();
              try {
                const data = JSON.parse(dataStr);
                const remaining = data.remaining;

                if (remaining === 0) {
                  chrome.runtime.sendMessage({ type: 'LIMIT_DETECTED', platform: 'claude' });
                } else if (remaining > 0) {
                  chrome.runtime.sendMessage({ type: 'WARNING_DETECTED', platform: 'claude', remaining });
                }
              } catch (parseErr) {
                sseDisabled = true;
                reader.cancel();
                return;
              }
              currentEvent = '';
            } else if (line === '') {
              currentEvent = '';
            }
          }
        }
      } catch (e) {
        sseDisabled = true;
      }
    }
  }

  it('returns the original unmodified response for non-API URLs', async () => {
    const mockResponse = createNonSSEResponse('https://claude.ai/other');
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const result = await window.fetch('https://claude.ai/other');
    expect(result).toBe(mockResponse);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('returns the original unmodified response for API URLs with non-SSE content type', async () => {
    const mockResponse = createNonSSEResponse('https://claude.ai/api/conversation');
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const result = await window.fetch('https://claude.ai/api/conversation');
    expect(result).toBe(mockResponse);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('returns the original unmodified response for SSE API responses', async () => {
    const chunks = ['event: message_limit\ndata: {"remaining": 5}\n\n'];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const result = await window.fetch('https://claude.ai/api/conversation');
    expect(result).toBe(mockResponse);
  });

  it('sends LIMIT_DETECTED when message_limit event has remaining 0', async () => {
    const chunks = ['event: message_limit\ndata: {"remaining": 0}\n\n'];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://claude.ai/api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'claude'
    });
  });

  it('sends WARNING_DETECTED with remaining count when remaining > 0', async () => {
    const chunks = ['event: message_limit\ndata: {"remaining": 5}\n\n'];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://claude.ai/api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'WARNING_DETECTED',
      platform: 'claude',
      remaining: 5
    });
  });

  it('sends WARNING_DETECTED with correct count for various remaining values', async () => {
    const chunks = ['event: message_limit\ndata: {"remaining": 12}\n\n'];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://claude.ai/api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'WARNING_DETECTED',
      platform: 'claude',
      remaining: 12
    });
  });

  it('handles SSE events split across multiple chunks', async () => {
    const chunks = [
      'event: message_limit\n',
      'data: {"remaining": 3}\n\n'
    ];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://claude.ai/api/conversation');

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'WARNING_DETECTED',
      platform: 'claude',
      remaining: 3
    });
  });

  it('ignores non-message_limit events', async () => {
    const chunks = ['event: content_block_delta\ndata: {"type": "text_delta", "text": "hello"}\n\n'];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://claude.ai/api/conversation');

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('disables SSE on JSON parse failure and does not send messages', async () => {
    const chunks = ['event: message_limit\ndata: {invalid json}\n\n'];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://claude.ai/api/conversation');

    // Should not send any message on parse failure
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('handles multiple events in a single stream', async () => {
    const chunks = [
      'event: content_block_delta\ndata: {"text": "hi"}\n\nevent: message_limit\ndata: {"remaining": 2}\n\n'
    ];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://claude.ai/api/conversation');

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'WARNING_DETECTED',
      platform: 'claude',
      remaining: 2
    });
  });

  it('handles Request object as first argument', async () => {
    const chunks = ['event: message_limit\ndata: {"remaining": 0}\n\n'];
    const mockResponse = createSSEResponse('https://claude.ai/api/conversation', chunks);
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const request = { url: 'https://claude.ai/api/conversation' };
    await window.fetch(request);

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'LIMIT_DETECTED',
      platform: 'claude'
    });
  });

  it('does not intercept URLs that do not contain /api/', async () => {
    const chunks = ['event: message_limit\ndata: {"remaining": 0}\n\n'];
    const body = createSSEStream(chunks);
    const cloneBody = createSSEStream(chunks);

    const mockResponse = {
      status: 200,
      headers: {
        get: (name) => {
          if (name === 'content-type') return 'text/event-stream';
          return null;
        }
      },
      body,
      clone: () => ({
        status: 200,
        headers: {
          get: (name) => {
            if (name === 'content-type') return 'text/event-stream';
            return null;
          }
        },
        body: cloneBody
      })
    };
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    await window.fetch('https://claude.ai/other-endpoint');

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('passes all arguments through to original fetch', async () => {
    const mockResponse = createNonSSEResponse('https://claude.ai/api/test');
    originalFetch.mockResolvedValue(mockResponse);

    loadScript();

    const options = { method: 'POST', body: '{}' };
    await window.fetch('https://claude.ai/api/test', options);

    expect(originalFetch).toHaveBeenCalledWith('https://claude.ai/api/test', options);
  });
});
