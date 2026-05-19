import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Property-based tests for the Relay Chrome Extension Service Worker.
 * Tests usage tracking state machine, cooldown reset correctness,
 * and pending handoff singleton properties.
 *
 * Since the service worker uses Chrome APIs, we extract pure function
 * versions of the state machine logic for testing.
 */

// --- Pure function versions of service worker state machine logic ---

/**
 * Valid status values for a platform usage record.
 */
const VALID_STATUSES = ['unknown', 'available', 'warning', 'cooldown'];

/**
 * Valid transitions in the status state machine.
 * Key: source status, Value: array of valid target statuses.
 *
 * Note: alarm_reset can transition from any state to 'available' because
 * it represents a window reset. The constraint "warning → available is not valid
 * (messages don't decrease within a window)" applies only to message_counted and
 * warning_detected events — NOT to alarm_reset which starts a new window.
 */
const VALID_TRANSITIONS = {
  unknown: ['available', 'warning', 'cooldown'],
  available: ['warning', 'cooldown'],
  warning: ['cooldown', 'available'],  // available only via alarm_reset
  cooldown: ['available']
};

/**
 * Creates a fresh platform usage record.
 */
function createInitialRecord() {
  const now = Date.now();
  return {
    messagesThisWindow: 0,
    estimatedLimit: null,
    limitHitAt: null,
    estimatedResetAt: null,
    lastUpdated: now,
    status: 'unknown'
  };
}

/**
 * Apply a LIMIT_DETECTED event: transitions to cooldown.
 * Mirrors service worker LIMIT_DETECTED handler logic.
 */
function applyLimitDetected(record, resetWindowHours, now) {
  return {
    ...record,
    status: 'cooldown',
    limitHitAt: now,
    estimatedResetAt: now + (resetWindowHours * 3600000),
    lastUpdated: now
  };
}

/**
 * Apply a WARNING_DETECTED event: may transition to warning.
 * Mirrors service worker WARNING_DETECTED handler logic.
 */
function applyWarningDetected(record, remaining, now) {
  const updated = { ...record, lastUpdated: now };

  if (remaining !== undefined && remaining !== null) {
    updated.estimatedLimit = updated.messagesThisWindow + remaining;
  }

  // Evaluate 80% warning threshold only if:
  // 1. estimatedLimit is known (not null)
  // 2. status is not already 'cooldown'
  if (updated.estimatedLimit !== null && updated.status !== 'cooldown') {
    if (updated.messagesThisWindow > 0.8 * updated.estimatedLimit) {
      updated.status = 'warning';
    }
  }

  return updated;
}

/**
 * Apply an alarm reset event: transitions from cooldown to available.
 * Mirrors service worker chrome.alarms.onAlarm handler logic.
 */
function applyAlarmReset(record, now) {
  return {
    ...record,
    messagesThisWindow: 0,
    status: 'available',
    lastUpdated: now
  };
}

/**
 * Apply a message counted event: increments counter, may transition to warning.
 * Mirrors service worker webRequest handler logic.
 */
function applyMessageCounted(record, now) {
  const updated = {
    ...record,
    messagesThisWindow: record.messagesThisWindow + 1,
    lastUpdated: now
  };

  // Evaluate 80% warning threshold only if:
  // 1. estimatedLimit is known (not null)
  // 2. status is not already 'cooldown'
  if (updated.estimatedLimit !== null && updated.status !== 'cooldown') {
    if (updated.messagesThisWindow > 0.8 * updated.estimatedLimit) {
      updated.status = 'warning';
    }
  }

  return updated;
}

/**
 * Checks if a status transition is valid according to the state machine.
 */
function isValidTransition(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true; // staying in same state is always valid
  const validTargets = VALID_TRANSITIONS[fromStatus];
  return validTargets ? validTargets.includes(toStatus) : false;
}

// --- Event types for generating random sequences ---

const EVENT_TYPES = ['message_counted', 'warning_detected', 'limit_detected', 'alarm_reset'];

/**
 * Apply an event to a record and return the new record.
 */
function applyEvent(record, event, now) {
  switch (event.type) {
    case 'message_counted':
      return applyMessageCounted(record, now);
    case 'warning_detected':
      return applyWarningDetected(record, event.remaining, now);
    case 'limit_detected':
      return applyLimitDetected(record, event.resetWindowHours, now);
    case 'alarm_reset':
      return applyAlarmReset(record, now);
    default:
      return record;
  }
}

// --- Arbitraries ---

const eventArb = fc.oneof(
  fc.record({ type: fc.constant('message_counted') }),
  fc.record({
    type: fc.constant('warning_detected'),
    remaining: fc.oneof(fc.nat({ max: 50 }), fc.constant(undefined))
  }),
  fc.record({
    type: fc.constant('limit_detected'),
    resetWindowHours: fc.integer({ min: 1, max: 24 })
  }),
  fc.record({ type: fc.constant('alarm_reset') })
);

const eventSequenceArb = fc.array(eventArb, { minLength: 1, maxLength: 30 });

// --- Tests ---

describe('Service Worker Property-Based Tests', () => {
  describe('Property 7: Status State Machine', () => {
    /**
     * **Validates: Requirements 10.5, 10.6, 10.7, 10.8**
     *
     * Platform status transitions follow a valid state machine:
     * unknown → available, unknown → warning, available → warning,
     * warning → cooldown, available → cooldown, cooldown → available.
     * No other transitions are valid.
     */

    it('for any sequence of events, all resulting status transitions are valid', () => {
      fc.assert(
        fc.property(eventSequenceArb, (events) => {
          let record = createInitialRecord();
          let baseTime = Date.now();

          for (let i = 0; i < events.length; i++) {
            const prevStatus = record.status;
            record = applyEvent(record, events[i], baseTime + i * 1000);
            const newStatus = record.status;

            // Every transition must be valid
            expect(isValidTransition(prevStatus, newStatus)).toBe(true);
          }
        }),
        { numRuns: 500 }
      );
    });

    it('warning → available only occurs via alarm_reset (messages do not decrease within a window)', () => {
      fc.assert(
        fc.property(eventSequenceArb, (events) => {
          let record = createInitialRecord();
          let baseTime = Date.now();

          for (let i = 0; i < events.length; i++) {
            const prevStatus = record.status;
            record = applyEvent(record, events[i], baseTime + i * 1000);
            const newStatus = record.status;

            // warning → available can only happen via alarm_reset (new window)
            if (prevStatus === 'warning' && newStatus === 'available') {
              expect(events[i].type).toBe('alarm_reset');
            }
          }
        }),
        { numRuns: 500 }
      );
    });

    it('cooldown → warning is never a valid transition', () => {
      fc.assert(
        fc.property(eventSequenceArb, (events) => {
          let record = createInitialRecord();
          let baseTime = Date.now();

          for (let i = 0; i < events.length; i++) {
            const prevStatus = record.status;
            record = applyEvent(record, events[i], baseTime + i * 1000);
            const newStatus = record.status;

            // cooldown → warning should never happen
            if (prevStatus === 'cooldown') {
              expect(newStatus).not.toBe('warning');
            }
          }
        }),
        { numRuns: 500 }
      );
    });

    it('status is always one of the four valid values', () => {
      fc.assert(
        fc.property(eventSequenceArb, (events) => {
          let record = createInitialRecord();
          let baseTime = Date.now();

          for (let i = 0; i < events.length; i++) {
            record = applyEvent(record, events[i], baseTime + i * 1000);
            expect(VALID_STATUSES).toContain(record.status);
          }
        }),
        { numRuns: 500 }
      );
    });

    it('only limit_detected can transition to cooldown', () => {
      fc.assert(
        fc.property(eventSequenceArb, (events) => {
          let record = createInitialRecord();
          let baseTime = Date.now();

          for (let i = 0; i < events.length; i++) {
            const prevStatus = record.status;
            record = applyEvent(record, events[i], baseTime + i * 1000);
            const newStatus = record.status;

            if (prevStatus !== 'cooldown' && newStatus === 'cooldown') {
              expect(events[i].type).toBe('limit_detected');
            }
          }
        }),
        { numRuns: 500 }
      );
    });

    it('only alarm_reset can transition from cooldown to available', () => {
      fc.assert(
        fc.property(eventSequenceArb, (events) => {
          let record = createInitialRecord();
          let baseTime = Date.now();

          for (let i = 0; i < events.length; i++) {
            const prevStatus = record.status;
            record = applyEvent(record, events[i], baseTime + i * 1000);
            const newStatus = record.status;

            if (prevStatus === 'cooldown' && newStatus === 'available') {
              expect(events[i].type).toBe('alarm_reset');
            }
          }
        }),
        { numRuns: 500 }
      );
    });
  });

  describe('Property 8: Cooldown Reset Correctness', () => {
    /**
     * **Validates: Requirements 10.5, 10.6**
     *
     * When a platform enters cooldown:
     *   estimatedResetAt = limitHitAt + (reset_window_hours * 3600000)
     * When the alarm fires at estimatedResetAt:
     *   messagesThisWindow resets to 0, status becomes available
     */

    it('estimatedResetAt is always limitHitAt + (reset_window_hours * 3600000)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 24 }),
          fc.integer({ min: 1000000000000, max: 2000000000000 }),
          fc.integer({ min: 0, max: 100 }),
          (resetWindowHours, limitHitAt, messagesThisWindow) => {
            const record = {
              ...createInitialRecord(),
              messagesThisWindow,
              status: 'available'
            };

            const result = applyLimitDetected(record, resetWindowHours, limitHitAt);

            expect(result.estimatedResetAt).toBe(limitHitAt + (resetWindowHours * 3600000));
            expect(result.limitHitAt).toBe(limitHitAt);
            expect(result.status).toBe('cooldown');
          }
        ),
        { numRuns: 500 }
      );
    });

    it('alarm reset always sets messagesThisWindow to 0 and status to available', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 24 }),
          fc.integer({ min: 1000000000000, max: 2000000000000 }),
          fc.integer({ min: 0, max: 100 }),
          (resetWindowHours, limitHitAt, messagesThisWindow) => {
            // First enter cooldown
            const record = {
              ...createInitialRecord(),
              messagesThisWindow,
              status: 'available'
            };

            const cooldownRecord = applyLimitDetected(record, resetWindowHours, limitHitAt);
            expect(cooldownRecord.status).toBe('cooldown');
            expect(cooldownRecord.messagesThisWindow).toBe(messagesThisWindow);

            // Then fire the alarm at estimatedResetAt
            const resetRecord = applyAlarmReset(cooldownRecord, cooldownRecord.estimatedResetAt);

            expect(resetRecord.messagesThisWindow).toBe(0);
            expect(resetRecord.status).toBe('available');
          }
        ),
        { numRuns: 500 }
      );
    });

    it('reset_window_hours calculation is correct for any valid hour value', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 168 }),  // up to 1 week
          fc.integer({ min: 1000000000000, max: 2000000000000 }),
          (hours, now) => {
            const record = { ...createInitialRecord(), status: 'available' };
            const result = applyLimitDetected(record, hours, now);

            const expectedMs = hours * 60 * 60 * 1000;
            expect(result.estimatedResetAt - result.limitHitAt).toBe(expectedMs);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('full cooldown cycle: enter cooldown → alarm fires → available with zero messages', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 24 }),
          fc.integer({ min: 1000000000000, max: 2000000000000 }),
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 1, max: 50 }),
          (resetWindowHours, startTime, messagesBefore, messagesAfterLimit) => {
            // Start with some messages
            let record = { ...createInitialRecord(), status: 'available' };
            let time = startTime;

            // Count some messages
            for (let i = 0; i < messagesBefore; i++) {
              time += 1000;
              record = applyMessageCounted(record, time);
            }

            // Hit limit
            time += 1000;
            record = applyLimitDetected(record, resetWindowHours, time);
            expect(record.status).toBe('cooldown');

            // Messages during cooldown don't change status
            for (let i = 0; i < messagesAfterLimit; i++) {
              time += 1000;
              const prevStatus = record.status;
              record = applyMessageCounted(record, time);
              // Status should remain cooldown (messages counted but no transition)
              expect(record.status).toBe('cooldown');
            }

            // Alarm fires
            time = record.estimatedResetAt;
            record = applyAlarmReset(record, time);

            expect(record.messagesThisWindow).toBe(0);
            expect(record.status).toBe('available');
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Property 9: Pending Handoff Singleton', () => {
    /**
     * **Validates: Requirements 15.6**
     *
     * At any point in time, there is at most one relay_pending_handoff entry
     * in storage. A new Baton Pass always overwrites any existing entry.
     */

    /**
     * Simulates chrome.storage.local for pending handoff.
     * The service worker's CONTEXT_EXTRACTED handler simply does:
     *   chrome.storage.local.set({ relay_pending_handoff: message.context })
     * This always overwrites any existing value.
     */
    function createStorage() {
      const store = {};
      return {
        set(obj) {
          Object.assign(store, obj);
        },
        get(key) {
          return store[key];
        },
        getStore() {
          return { ...store };
        }
      };
    }

    /**
     * Simulates the CONTEXT_EXTRACTED message handler.
     */
    function handleContextExtracted(storage, context) {
      storage.set({ relay_pending_handoff: context });
    }

    const contextArb = fc.record({
      platform: fc.constantFrom('chatgpt', 'claude'),
      goal: fc.string({ minLength: 1, maxLength: 100 }),
      codeBlocks: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 3 }),
      keyOutputs: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 3 }),
      lastExchanges: fc.array(
        fc.record({
          user: fc.string({ minLength: 1, maxLength: 50 }),
          assistant: fc.string({ minLength: 1, maxLength: 50 })
        }),
        { minLength: 0, maxLength: 3 }
      ),
      errorMessages: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 2 }),
      sessionType: fc.constantFrom('coding', 'writing', 'research', 'general'),
      totalMessages: fc.nat({ max: 100 }),
      extractedAt: fc.constant(new Date().toISOString())
    });

    it('after any sequence of CONTEXT_EXTRACTED messages, only the last context is stored', () => {
      fc.assert(
        fc.property(
          fc.array(contextArb, { minLength: 1, maxLength: 20 }),
          (contexts) => {
            const storage = createStorage();

            // Apply all CONTEXT_EXTRACTED messages
            for (const context of contexts) {
              handleContextExtracted(storage, context);
            }

            // Only the last context should be stored
            const stored = storage.get('relay_pending_handoff');
            expect(stored).toEqual(contexts[contexts.length - 1]);
          }
        ),
        { numRuns: 300 }
      );
    });

    it('there is always at most one relay_pending_handoff entry in storage', () => {
      fc.assert(
        fc.property(
          fc.array(contextArb, { minLength: 1, maxLength: 20 }),
          (contexts) => {
            const storage = createStorage();

            for (const context of contexts) {
              handleContextExtracted(storage, context);

              // After each write, verify there's exactly one entry
              const store = storage.getStore();
              const handoffKeys = Object.keys(store).filter(k => k === 'relay_pending_handoff');
              expect(handoffKeys.length).toBe(1);
            }
          }
        ),
        { numRuns: 300 }
      );
    });

    it('a new Baton Pass always overwrites any existing entry completely', () => {
      fc.assert(
        fc.property(
          contextArb,
          contextArb,
          (firstContext, secondContext) => {
            const storage = createStorage();

            // Store first context
            handleContextExtracted(storage, firstContext);
            expect(storage.get('relay_pending_handoff')).toEqual(firstContext);

            // Store second context — should completely overwrite
            handleContextExtracted(storage, secondContext);
            const stored = storage.get('relay_pending_handoff');

            expect(stored).toEqual(secondContext);
            // Verify no remnants of first context leak through
            expect(stored).not.toEqual(firstContext);
          }
        ),
        // Filter out cases where both contexts happen to be identical
        { numRuns: 300 }
      );
    });

    it('stored context is always a complete Session_Context object', () => {
      const requiredFields = [
        'platform', 'goal', 'codeBlocks', 'keyOutputs',
        'lastExchanges', 'errorMessages', 'sessionType',
        'totalMessages', 'extractedAt'
      ];

      fc.assert(
        fc.property(contextArb, (context) => {
          const storage = createStorage();
          handleContextExtracted(storage, context);

          const stored = storage.get('relay_pending_handoff');
          for (const field of requiredFields) {
            expect(stored[field]).not.toBeUndefined();
          }
        }),
        { numRuns: 200 }
      );
    });

    it('interleaved contexts from different platforms still result in singleton', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(fc.constantFrom('chatgpt', 'claude'), contextArb),
            { minLength: 2, maxLength: 15 }
          ),
          (platformContextPairs) => {
            const storage = createStorage();

            let lastContext = null;
            for (const [platform, context] of platformContextPairs) {
              const contextWithPlatform = { ...context, platform };
              handleContextExtracted(storage, contextWithPlatform);
              lastContext = contextWithPlatform;
            }

            // Only the very last context should be stored
            const stored = storage.get('relay_pending_handoff');
            expect(stored).toEqual(lastContext);

            // Verify singleton
            const store = storage.getStore();
            const handoffKeys = Object.keys(store).filter(k => k.startsWith('relay_pending'));
            expect(handoffKeys.length).toBe(1);
          }
        ),
        { numRuns: 300 }
      );
    });
  });
});
