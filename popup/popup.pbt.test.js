import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property-based tests for the Relay Chrome Extension Popup Smart Suggestion logic.
 * Uses fast-check to verify Property 13: Smart Suggestion Optimality.
 *
 * Since popup.js uses chrome APIs and is not a module, we re-implement the core
 * logic (getRemainingRatio and getSmartSuggestion) here for testable verification.
 * The logic mirrors popup.js exactly.
 */

/**
 * **Validates: Requirements 11.7**
 *
 * The popup's smart suggestion always recommends the platform with the highest
 * remaining ratio among platforms with status available or warning.
 * If all platforms are cooldown or unknown, no platform is recommended (returns null).
 */

// --- Re-implementation of core logic from popup.js for testing ---

const PLATFORMS = ['chatgpt', 'claude'];

/**
 * Calculate the remaining ratio for a platform record.
 * Returns (estimatedLimit - messagesThisWindow) / estimatedLimit
 * or null if estimatedLimit is not known or is 0.
 */
function getRemainingRatio(record) {
  if (record.estimatedLimit == null || record.estimatedLimit === 0) return null;
  return (record.estimatedLimit - record.messagesThisWindow) / record.estimatedLimit;
}

/**
 * Determine the smart suggestion: recommend the platform with the highest
 * remaining ratio among available/warning platforms.
 * If tied, recommend alphabetically first.
 * If no candidates, return null.
 */
function getSmartSuggestion(usageData) {
  if (!usageData) return null;

  const candidates = [];

  for (const platform of PLATFORMS) {
    const record = usageData[platform];
    if (!record) continue;
    if (record.status === 'available' || record.status === 'warning') {
      const ratio = getRemainingRatio(record);
      if (ratio !== null) {
        candidates.push({ platform, ratio });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by ratio descending, then alphabetically for ties
  candidates.sort((a, b) => {
    if (b.ratio !== a.ratio) return b.ratio - a.ratio;
    return a.platform.localeCompare(b.platform);
  });

  return candidates[0].platform;
}

// --- Arbitraries ---

const statusArb = fc.constantFrom('available', 'warning', 'cooldown', 'unknown');
const availableStatusArb = fc.constantFrom('available', 'warning');
const unavailableStatusArb = fc.constantFrom('cooldown', 'unknown');

/**
 * Arbitrary for a platform usage record with a valid estimatedLimit > 0.
 */
const usageRecordArb = fc.record({
  status: statusArb,
  messagesThisWindow: fc.integer({ min: 0, max: 100 }),
  estimatedLimit: fc.integer({ min: 1, max: 100 }),
  limitHitAt: fc.constant(null),
  estimatedResetAt: fc.constant(null),
  lastUpdated: fc.constant(new Date().toISOString())
});

/**
 * Arbitrary for a platform record that is available or warning with valid limit.
 */
const candidateRecordArb = fc.record({
  status: availableStatusArb,
  messagesThisWindow: fc.integer({ min: 0, max: 99 }),
  estimatedLimit: fc.integer({ min: 1, max: 100 }),
  limitHitAt: fc.constant(null),
  estimatedResetAt: fc.constant(null),
  lastUpdated: fc.constant(new Date().toISOString())
});

/**
 * Arbitrary for a platform record that is cooldown or unknown.
 */
const nonCandidateRecordArb = fc.record({
  status: unavailableStatusArb,
  messagesThisWindow: fc.integer({ min: 0, max: 100 }),
  estimatedLimit: fc.integer({ min: 1, max: 100 }),
  limitHitAt: fc.constant(null),
  estimatedResetAt: fc.constant(null),
  lastUpdated: fc.constant(new Date().toISOString())
});

/**
 * Arbitrary for full usageData with both platforms.
 */
const usageDataArb = fc.record({
  chatgpt: usageRecordArb,
  claude: usageRecordArb
});

describe('Popup Smart Suggestion Property-Based Tests', () => {
  describe('Property 13: Smart Suggestion Optimality', () => {
    /**
     * **Validates: Requirements 11.7**
     */

    it('when one platform has a higher ratio, it is always recommended', () => {
      fc.assert(
        fc.property(
          candidateRecordArb,
          candidateRecordArb,
          (chatgptRecord, claudeRecord) => {
            const chatgptRatio = getRemainingRatio(chatgptRecord);
            const claudeRatio = getRemainingRatio(claudeRecord);

            // Skip if ratios are equal (tie-breaking tested separately)
            fc.pre(chatgptRatio !== claudeRatio);

            const usageData = { chatgpt: chatgptRecord, claude: claudeRecord };
            const result = getSmartSuggestion(usageData);

            if (chatgptRatio > claudeRatio) {
              expect(result).toBe('chatgpt');
            } else {
              expect(result).toBe('claude');
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('when ratios are equal, alphabetically first platform is recommended', () => {
      fc.assert(
        fc.property(
          availableStatusArb,
          availableStatusArb,
          fc.integer({ min: 0, max: 99 }),
          fc.integer({ min: 1, max: 100 }),
          (chatgptStatus, claudeStatus, messages, limit) => {
            // Both platforms have the same messages and limit → same ratio
            fc.pre(limit > 0);

            const usageData = {
              chatgpt: {
                status: chatgptStatus,
                messagesThisWindow: messages,
                estimatedLimit: limit,
                limitHitAt: null,
                estimatedResetAt: null,
                lastUpdated: new Date().toISOString()
              },
              claude: {
                status: claudeStatus,
                messagesThisWindow: messages,
                estimatedLimit: limit,
                limitHitAt: null,
                estimatedResetAt: null,
                lastUpdated: new Date().toISOString()
              }
            };

            const result = getSmartSuggestion(usageData);
            // 'chatgpt' < 'claude' alphabetically
            expect(result).toBe('chatgpt');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('when all platforms are cooldown/unknown, null is returned', () => {
      fc.assert(
        fc.property(
          nonCandidateRecordArb,
          nonCandidateRecordArb,
          (chatgptRecord, claudeRecord) => {
            const usageData = { chatgpt: chatgptRecord, claude: claudeRecord };
            const result = getSmartSuggestion(usageData);
            expect(result).toBeNull();
          }
        ),
        { numRuns: 200 }
      );
    });

    it('the recommended platform always has status available or warning', () => {
      fc.assert(
        fc.property(usageDataArb, (usageData) => {
          const result = getSmartSuggestion(usageData);

          if (result !== null) {
            const record = usageData[result];
            expect(['available', 'warning']).toContain(record.status);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('the recommended platform always has the highest ratio among candidates', () => {
      fc.assert(
        fc.property(usageDataArb, (usageData) => {
          const result = getSmartSuggestion(usageData);

          if (result !== null) {
            const resultRatio = getRemainingRatio(usageData[result]);

            // Check all other candidates have ratio <= resultRatio
            for (const platform of PLATFORMS) {
              if (platform === result) continue;
              const record = usageData[platform];
              if (!record) continue;
              if (record.status === 'available' || record.status === 'warning') {
                const otherRatio = getRemainingRatio(record);
                if (otherRatio !== null) {
                  expect(otherRatio).toBeLessThanOrEqual(resultRatio);
                }
              }
            }
          }
        }),
        { numRuns: 200 }
      );
    });
  });
});
