import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractContext, classifySessionType } from './extractor.js';

/**
 * Helper to set up a jsdom document and assign it globally.
 */
function setupDOM(html = '<body></body>') {
  const dom = new JSDOM(html);
  global.document = dom.window.document;
  return dom;
}

const chatgptSelectors = {
  message_selectors: {
    user: "[data-message-author-role='user']",
    assistant: "[data-message-author-role='assistant']"
  },
  code_block_selectors: ['pre code']
};

describe('extractContext', () => {
  afterEach(() => {
    delete global.document;
  });

  describe('empty conversation guard', () => {
    it('returns zeroed context when no messages are found', () => {
      setupDOM('<body><div>Empty page</div></body>');

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.platform).toBe('chatgpt');
      expect(result.goal).toBe('');
      expect(result.codeBlocks).toEqual([]);
      expect(result.keyOutputs).toEqual([]);
      expect(result.lastExchanges).toEqual([]);
      expect(result.errorMessages).toEqual([]);
      expect(result.sessionType).toBe('general');
      expect(result.totalMessages).toBe(0);
      expect(result.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns zeroed context when selectors are null', () => {
      setupDOM('<body></body>');

      const result = extractContext('chatgpt', null);

      expect(result.totalMessages).toBe(0);
      expect(result.goal).toBe('');
      expect(result.sessionType).toBe('general');
    });

    it('returns zeroed context when message_selectors is missing', () => {
      setupDOM('<body></body>');

      const result = extractContext('claude', {});

      expect(result.totalMessages).toBe(0);
      expect(result.goal).toBe('');
    });
  });

  describe('goal extraction', () => {
    it('extracts the first user message as goal', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Write a function to sort arrays</div>
        <div data-message-author-role="assistant">Here is a sort function...</div>
        <div data-message-author-role="user">Can you optimize it?</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.goal).toBe('Write a function to sort arrays');
    });

    it('trims whitespace from goal', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">   Hello world   </div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.goal).toBe('Hello world');
    });

    it('sets goal to empty string when first user message is whitespace-only', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">   </div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.goal).toBe('');
    });
  });

  describe('sessionType classification', () => {
    it('classifies coding keywords', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Help me debug this function</div>
        <div data-message-author-role="assistant">Sure, let me look at it.</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.sessionType).toBe('coding');
    });

    it('classifies writing keywords', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Write an essay about climate change</div>
        <div data-message-author-role="assistant">Here is an essay...</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.sessionType).toBe('writing');
    });

    it('classifies research keywords', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Explain how photosynthesis works</div>
        <div data-message-author-role="assistant">Photosynthesis is...</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.sessionType).toBe('research');
    });

    it('defaults to general when no keywords match', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Hello there</div>
        <div data-message-author-role="assistant">Hi!</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.sessionType).toBe('general');
    });

    it('coding takes priority over writing when both match', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Write a function that sorts</div>
        <div data-message-author-role="assistant">Here you go.</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.sessionType).toBe('coding');
    });

    it('writing takes priority over research when both match', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Write an article that explains quantum physics</div>
        <div data-message-author-role="assistant">Here is the article.</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.sessionType).toBe('writing');
    });

    it('sets sessionType to general when goal is empty/whitespace', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">   </div>
        <div data-message-author-role="assistant">I can help with code!</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.sessionType).toBe('general');
    });

    it('is case-insensitive for keyword matching', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">DEBUG my API endpoint</div>
        <div data-message-author-role="assistant">Let me check.</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.sessionType).toBe('coding');
    });
  });

  describe('codeBlocks extraction', () => {
    it('extracts all code block contents in DOM order', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Show me code</div>
        <div data-message-author-role="assistant">
          <pre><code>const x = 1;</code></pre>
          <pre><code>function hello() {}</code></pre>
        </div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.codeBlocks).toEqual(['const x = 1;', 'function hello() {}']);
    });

    it('returns empty array when no code blocks exist', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Hello</div>
        <div data-message-author-role="assistant">Hi there!</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.codeBlocks).toEqual([]);
    });
  });

  describe('keyOutputs extraction', () => {
    it('includes assistant messages > 200 chars without code blocks', () => {
      const longText = 'A'.repeat(201);
      setupDOM(`<body>
        <div data-message-author-role="user">Tell me something</div>
        <div data-message-author-role="assistant">${longText}</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.keyOutputs).toHaveLength(1);
      expect(result.keyOutputs[0]).toBe(longText);
    });

    it('excludes assistant messages <= 200 chars', () => {
      const shortText = 'A'.repeat(200);
      setupDOM(`<body>
        <div data-message-author-role="user">Hi</div>
        <div data-message-author-role="assistant">${shortText}</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.keyOutputs).toEqual([]);
    });

    it('excludes assistant messages that contain code blocks', () => {
      const longText = 'B'.repeat(201);
      setupDOM(`<body>
        <div data-message-author-role="user">Show code</div>
        <div data-message-author-role="assistant">${longText}<pre><code>x = 1</code></pre></div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.keyOutputs).toEqual([]);
    });
  });

  describe('lastExchanges extraction', () => {
    it('returns last 10 user-assistant pairs (or all if fewer)', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Q1</div>
        <div data-message-author-role="assistant">A1</div>
        <div data-message-author-role="user">Q2</div>
        <div data-message-author-role="assistant">A2</div>
        <div data-message-author-role="user">Q3</div>
        <div data-message-author-role="assistant">A3</div>
        <div data-message-author-role="user">Q4</div>
        <div data-message-author-role="assistant">A4</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.lastExchanges).toHaveLength(4);
      expect(result.lastExchanges[0]).toEqual({ user: 'Q1', assistant: 'A1' });
      expect(result.lastExchanges[1]).toEqual({ user: 'Q2', assistant: 'A2' });
      expect(result.lastExchanges[2]).toEqual({ user: 'Q3', assistant: 'A3' });
      expect(result.lastExchanges[3]).toEqual({ user: 'Q4', assistant: 'A4' });
    });

    it('returns fewer than 3 pairs if conversation is shorter', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Q1</div>
        <div data-message-author-role="assistant">A1</div>
        <div data-message-author-role="user">Q2</div>
        <div data-message-author-role="assistant">A2</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.lastExchanges).toHaveLength(2);
      expect(result.lastExchanges[0]).toEqual({ user: 'Q1', assistant: 'A1' });
      expect(result.lastExchanges[1]).toEqual({ user: 'Q2', assistant: 'A2' });
    });

    it('handles uneven user/assistant counts by pairing available messages', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Q1</div>
        <div data-message-author-role="assistant">A1</div>
        <div data-message-author-role="user">Q2</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.lastExchanges).toHaveLength(1);
      expect(result.lastExchanges[0]).toEqual({ user: 'Q1', assistant: 'A1' });
    });
  });

  describe('errorMessages extraction', () => {
    it('detects messages containing error keywords (case-insensitive)', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">I have a Bug in my code</div>
        <div data-message-author-role="assistant">Let me help you fix that issue</div>
        <div data-message-author-role="user">Thanks!</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.errorMessages).toHaveLength(2);
      expect(result.errorMessages[0]).toBe('I have a Bug in my code');
      expect(result.errorMessages[1]).toBe('Let me help you fix that issue');
    });

    it('detects ERROR in uppercase', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Getting an ERROR message</div>
        <div data-message-author-role="assistant">Try restarting.</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.errorMessages).toHaveLength(1);
      expect(result.errorMessages[0]).toBe('Getting an ERROR message');
    });

    it('returns empty array when no error keywords found', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Hello</div>
        <div data-message-author-role="assistant">Hi there!</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.errorMessages).toEqual([]);
    });
  });

  describe('totalMessages and extractedAt', () => {
    it('counts all user and assistant messages', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Q1</div>
        <div data-message-author-role="assistant">A1</div>
        <div data-message-author-role="user">Q2</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.totalMessages).toBe(3);
    });

    it('extractedAt is a valid ISO 8601 timestamp', () => {
      setupDOM(`<body>
        <div data-message-author-role="user">Hi</div>
      </body>`);

      const result = extractContext('chatgpt', chatgptSelectors);

      expect(result.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(() => new Date(result.extractedAt)).not.toThrow();
    });
  });
});

describe('classifySessionType', () => {
  it('returns general for empty string', () => {
    expect(classifySessionType('')).toBe('general');
  });

  it('returns general for whitespace-only string', () => {
    expect(classifySessionType('   ')).toBe('general');
  });

  it('returns general for null', () => {
    expect(classifySessionType(null)).toBe('general');
  });

  it('returns general for undefined', () => {
    expect(classifySessionType(undefined)).toBe('general');
  });

  it('detects coding keywords', () => {
    expect(classifySessionType('help me debug this')).toBe('coding');
    expect(classifySessionType('write a function')).toBe('coding');
    expect(classifySessionType('fix this bug')).toBe('coding');
    expect(classifySessionType('call the API')).toBe('coding');
    expect(classifySessionType('create a class')).toBe('coding');
    expect(classifySessionType('run this script')).toBe('coding');
    expect(classifySessionType('show me the code')).toBe('coding');
    expect(classifySessionType('there is an error')).toBe('coding');
  });

  it('detects writing keywords', () => {
    expect(classifySessionType('draft a letter')).toBe('writing');
    expect(classifySessionType('write an essay')).toBe('writing');
    expect(classifySessionType('create an article')).toBe('writing');
    expect(classifySessionType('add a paragraph')).toBe('writing');
    expect(classifySessionType('start a blog post')).toBe('writing');
  });

  it('detects research keywords', () => {
    expect(classifySessionType('research quantum computing')).toBe('research');
    expect(classifySessionType('explain gravity')).toBe('research');
    expect(classifySessionType('what is machine learning')).toBe('research');
    expect(classifySessionType('how does DNS work')).toBe('research');
    expect(classifySessionType('summarize this paper')).toBe('research');
  });

  it('returns general when no keywords match', () => {
    expect(classifySessionType('hello there')).toBe('general');
    expect(classifySessionType('thanks for helping')).toBe('general');
  });

  it('is case-insensitive', () => {
    expect(classifySessionType('DEBUG THIS')).toBe('coding');
    expect(classifySessionType('WRITE an ESSAY')).toBe('writing');
    expect(classifySessionType('EXPLAIN this concept')).toBe('research');
  });

  it('coding takes priority over writing', () => {
    // "write" is writing, but "function" is coding — coding wins
    expect(classifySessionType('write a function')).toBe('coding');
  });

  it('coding takes priority over research', () => {
    // "explain" is research, but "error" is coding — coding wins
    expect(classifySessionType('explain this error')).toBe('coding');
  });

  it('writing takes priority over research', () => {
    // "explain" is research, but "write" is also writing — writing wins
    // Actually "write" matches coding keyword too... let's use a better example
    expect(classifySessionType('draft an article that explains')).toBe('writing');
  });
});
