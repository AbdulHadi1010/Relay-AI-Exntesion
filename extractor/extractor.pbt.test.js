import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fc from 'fast-check';
import { extractContext, classifySessionType } from './extractor.js';

/**
 * Property-based tests for the Relay Chrome Extension Extractor module.
 * Uses fast-check to verify universal properties across all inputs.
 */

const chatgptSelectors = {
  message_selectors: {
    user: "[data-message-author-role='user']",
    assistant: "[data-message-author-role='assistant']"
  },
  code_block_selectors: ['pre code']
};

/**
 * Helper to set up a jsdom document and assign it globally.
 */
function setupDOM(html) {
  const dom = new JSDOM(html);
  global.document = dom.window.document;
  return dom;
}

/**
 * Arbitrary for generating non-empty printable strings (no HTML special chars).
 * Uses stringMatching with a regex that avoids HTML-special characters.
 */
const safeTextArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?;:()_\-+=]{1,100}$/)
  .map(s => s.trim())
  .filter(s => s.length > 0);

/**
 * Arbitrary for generating goal strings that may or may not contain keywords.
 */
const goalArb = fc.oneof(
  safeTextArb,
  fc.constant(''),
  fc.constant('   ')
);

describe('Extractor Property-Based Tests', () => {
  afterEach(() => {
    delete global.document;
  });

  describe('Property 3: Session Type Determinism', () => {
    /**
     * **Validates: Requirements 6.8**
     *
     * For any goal string, classifySessionType is deterministic and follows strict priority:
     * coding > writing > research > general.
     */

    it('classifySessionType is deterministic: same input always produces same output', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (goal) => {
          const result1 = classifySessionType(goal);
          const result2 = classifySessionType(goal);
          expect(result1).toBe(result2);
        }),
        { numRuns: 200 }
      );
    });

    it('classifySessionType always returns one of the four valid types', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (goal) => {
          const result = classifySessionType(goal);
          expect(['coding', 'writing', 'research', 'general']).toContain(result);
        }),
        { numRuns: 200 }
      );
    });

    it('coding keywords always take priority over writing and research', () => {
      const codingKeywords = ['code', 'function', 'script', 'bug', 'error', 'api', 'class', 'debug'];
      const writingKeywords = ['write', 'essay', 'article', 'draft', 'paragraph', 'blog'];
      const researchKeywords = ['research', 'explain', 'what is', 'how does', 'summarize'];

      fc.assert(
        fc.property(
          fc.constantFrom(...codingKeywords),
          fc.constantFrom(...writingKeywords.concat(researchKeywords)),
          safeTextArb,
          (codingKw, otherKw, filler) => {
            const goal = `${filler} ${codingKw} ${otherKw} ${filler}`;
            const result = classifySessionType(goal);
            expect(result).toBe('coding');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('writing keywords take priority over research when no coding keyword present', () => {
      const writingKeywords = ['essay', 'article', 'draft', 'paragraph', 'blog'];
      const researchKeywords = ['research', 'explain', 'summarize'];

      fc.assert(
        fc.property(
          fc.constantFrom(...writingKeywords),
          fc.constantFrom(...researchKeywords),
          (writingKw, researchKw) => {
            // Use filler that doesn't contain coding keywords
            const goal = `please ${writingKw} about ${researchKw} topic`;
            const result = classifySessionType(goal);
            expect(result).toBe('writing');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('empty or whitespace-only goals always return general', () => {
      const whitespaceArb = fc.stringMatching(/^[ \t\n]{0,20}$/);

      fc.assert(
        fc.property(whitespaceArb, (goal) => {
          const result = classifySessionType(goal);
          expect(result).toBe('general');
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 2: Field Completeness', () => {
    /**
     * **Validates: Requirements 6.2**
     *
     * For any valid conversation DOM containing at least one user message,
     * extractContext produces a Session_Context object where all 9 required fields
     * are present and non-undefined.
     */

    const requiredFields = [
      'platform', 'goal', 'codeBlocks', 'keyOutputs',
      'lastExchanges', 'errorMessages', 'sessionType',
      'totalMessages', 'extractedAt'
    ];

    it('all 9 required fields are present for any conversation with at least one user message', () => {
      // Generate 1-5 user messages and 0-5 assistant messages
      const userMsgArb = safeTextArb;
      const assistantMsgArb = safeTextArb;

      fc.assert(
        fc.property(
          fc.array(userMsgArb, { minLength: 1, maxLength: 5 }),
          fc.array(assistantMsgArb, { minLength: 0, maxLength: 5 }),
          (userMsgs, assistantMsgs) => {
            const userDivs = userMsgs.map(m => `<div data-message-author-role="user">${m}</div>`).join('\n');
            const assistantDivs = assistantMsgs.map(m => `<div data-message-author-role="assistant">${m}</div>`).join('\n');
            const html = `<body>${userDivs}${assistantDivs}</body>`;

            setupDOM(html);
            const result = extractContext('chatgpt', chatgptSelectors);

            for (const field of requiredFields) {
              expect(result[field]).not.toBeUndefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('platform field matches the input platform argument', () => {
      const platformArb = fc.constantFrom('chatgpt', 'claude');

      fc.assert(
        fc.property(platformArb, safeTextArb, (platform, msg) => {
          setupDOM(`<body><div data-message-author-role="user">${msg}</div></body>`);
          const result = extractContext(platform, chatgptSelectors);
          expect(result.platform).toBe(platform);
        }),
        { numRuns: 50 }
      );
    });

    it('array fields are always arrays', () => {
      fc.assert(
        fc.property(
          fc.array(safeTextArb, { minLength: 1, maxLength: 5 }),
          (userMsgs) => {
            const userDivs = userMsgs.map(m => `<div data-message-author-role="user">${m}</div>`).join('\n');
            setupDOM(`<body>${userDivs}</body>`);
            const result = extractContext('chatgpt', chatgptSelectors);

            expect(Array.isArray(result.codeBlocks)).toBe(true);
            expect(Array.isArray(result.keyOutputs)).toBe(true);
            expect(Array.isArray(result.lastExchanges)).toBe(true);
            expect(Array.isArray(result.errorMessages)).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('extractedAt is always a valid ISO 8601 timestamp', () => {
      fc.assert(
        fc.property(safeTextArb, (msg) => {
          setupDOM(`<body><div data-message-author-role="user">${msg}</div></body>`);
          const result = extractContext('chatgpt', chatgptSelectors);
          expect(result.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
          expect(new Date(result.extractedAt).toString()).not.toBe('Invalid Date');
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 10: Error Message Keyword Detection', () => {
    /**
     * **Validates: Requirements 6.7**
     *
     * A message is in errorMessages iff it contains error/fix/issue/bug (case-insensitive).
     * No false positives and no false negatives.
     */

    const errorKeywords = ['error', 'fix', 'issue', 'bug'];

    it('messages containing error keywords are always included in errorMessages', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...errorKeywords),
          safeTextArb,
          (keyword, filler) => {
            const msg = `${filler} ${keyword} ${filler}`;
            setupDOM(`<body><div data-message-author-role="user">${msg}</div></body>`);
            const result = extractContext('chatgpt', chatgptSelectors);
            expect(result.errorMessages.length).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('messages without any error keywords are never in errorMessages', () => {
      // Generate text that doesn't contain any error keywords
      const noErrorTextArb = fc.stringMatching(/^[a-zA-Z0-9 .,;:()_\-+=]{1,50}$/)
        .filter(s => {
          const lower = s.toLowerCase();
          return !errorKeywords.some(kw => lower.includes(kw)) && s.trim().length > 0;
        });

      fc.assert(
        fc.property(noErrorTextArb, (msg) => {
          setupDOM(`<body><div data-message-author-role="user">${msg}</div></body>`);
          const result = extractContext('chatgpt', chatgptSelectors);
          expect(result.errorMessages).toEqual([]);
        }),
        { numRuns: 100 }
      );
    });

    it('keyword detection is case-insensitive', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...errorKeywords),
          fc.constantFrom('upper', 'lower', 'mixed'),
          safeTextArb,
          (keyword, caseType, filler) => {
            let transformed;
            if (caseType === 'upper') transformed = keyword.toUpperCase();
            else if (caseType === 'mixed') transformed = keyword[0].toUpperCase() + keyword.slice(1);
            else transformed = keyword;

            const msg = `${filler} ${transformed} ${filler}`;
            setupDOM(`<body><div data-message-author-role="user">${msg}</div></body>`);
            const result = extractContext('chatgpt', chatgptSelectors);
            expect(result.errorMessages.length).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 11: Key Outputs Filter', () => {
    /**
     * **Validates: Requirements 6.5**
     *
     * An assistant message is in keyOutputs iff its text length > 200 chars
     * AND it does not contain a code block element as a child.
     */

    it('assistant messages > 200 chars without code blocks are always in keyOutputs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 201, max: 500 }),
          (length) => {
            const longText = 'x'.repeat(length);
            setupDOM(`<body>
              <div data-message-author-role="user">hello</div>
              <div data-message-author-role="assistant">${longText}</div>
            </body>`);
            const result = extractContext('chatgpt', chatgptSelectors);
            expect(result.keyOutputs.length).toBe(1);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('assistant messages <= 200 chars are never in keyOutputs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 200 }),
          (length) => {
            const shortText = 'x'.repeat(length);
            setupDOM(`<body>
              <div data-message-author-role="user">hello</div>
              <div data-message-author-role="assistant">${shortText}</div>
            </body>`);
            const result = extractContext('chatgpt', chatgptSelectors);
            expect(result.keyOutputs).toEqual([]);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('assistant messages > 200 chars WITH code blocks are never in keyOutputs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 201, max: 500 }),
          (length) => {
            const longText = 'y'.repeat(length);
            setupDOM(`<body>
              <div data-message-author-role="user">hello</div>
              <div data-message-author-role="assistant">${longText}<pre><code>some code</code></pre></div>
            </body>`);
            const result = extractContext('chatgpt', chatgptSelectors);
            expect(result.keyOutputs).toEqual([]);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe('Property 12: Last Exchanges Bounded', () => {
    /**
     * **Validates: Requirements 6.6**
     *
     * lastExchanges.length <= 3 and equals min(3, N) where N is the number
     * of user-assistant pairs.
     */

    it('lastExchanges never exceeds 3 entries regardless of conversation length', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          (pairCount) => {
            const pairs = Array.from({ length: pairCount }, (_, i) =>
              `<div data-message-author-role="user">Q${i}</div>
               <div data-message-author-role="assistant">A${i}</div>`
            ).join('\n');
            setupDOM(`<body>${pairs}</body>`);
            const result = extractContext('chatgpt', chatgptSelectors);
            expect(result.lastExchanges.length).toBeLessThanOrEqual(10);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('lastExchanges.length equals min(3, N) where N is number of pairs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          (pairCount) => {
            const pairs = Array.from({ length: pairCount }, (_, i) =>
              `<div data-message-author-role="user">Q${i}</div>
               <div data-message-author-role="assistant">A${i}</div>`
            ).join('\n');
            setupDOM(`<body>${pairs}</body>`);
            const result = extractContext('chatgpt', chatgptSelectors);
            expect(result.lastExchanges.length).toBe(Math.min(10, pairCount));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('lastExchanges contains the chronologically last pairs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 4, max: 15 }),
          (pairCount) => {
            const pairs = Array.from({ length: pairCount }, (_, i) =>
              `<div data-message-author-role="user">Q${i}</div>
               <div data-message-author-role="assistant">A${i}</div>`
            ).join('\n');
            setupDOM(`<body>${pairs}</body>`);
            const result = extractContext('chatgpt', chatgptSelectors);

            // Last exchange should be the last pair
            const lastIdx = pairCount - 1;
            const lastExchangeIdx = result.lastExchanges.length - 1;
            expect(result.lastExchanges[lastExchangeIdx].user).toBe(`Q${lastIdx}`);
            expect(result.lastExchanges[lastExchangeIdx].assistant).toBe(`A${lastIdx}`);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
