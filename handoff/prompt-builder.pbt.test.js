import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildHandoffPrompt, MAX_PROMPT_LENGTH, CONTINUATION_INSTRUCTION } from './prompt-builder.js';

/**
 * Property-based tests for the Relay Chrome Extension Prompt Builder.
 * Uses fast-check to verify universal structural properties across all inputs.
 */

/**
 * Arbitrary for generating valid Session_Context objects.
 */
const sessionTypeArb = fc.constantFrom('coding', 'writing', 'research', 'general');
const platformArb = fc.constantFrom('chatgpt', 'claude');
const safeTextArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?;:()_\-+=]{1,100}$/)
  .map(s => s.trim())
  .filter(s => s.length > 0);

const exchangeArb = fc.record({
  user: safeTextArb,
  assistant: safeTextArb
});

const contextArb = fc.record({
  sessionType: sessionTypeArb,
  platform: platformArb,
  goal: fc.oneof(safeTextArb, fc.constant('')),
  keyOutputs: fc.array(safeTextArb, { minLength: 0, maxLength: 5 }),
  codeBlocks: fc.array(safeTextArb, { minLength: 0, maxLength: 3 }),
  lastExchanges: fc.array(exchangeArb, { minLength: 0, maxLength: 3 }),
  errorMessages: fc.array(safeTextArb, { minLength: 0, maxLength: 3 }),
  totalMessages: fc.nat({ max: 100 }),
  extractedAt: fc.constant(new Date().toISOString())
});

/**
 * Context with empty codeBlocks to test conditional omission.
 */
const contextNoCodeArb = fc.record({
  sessionType: sessionTypeArb,
  platform: platformArb,
  goal: fc.oneof(safeTextArb, fc.constant('')),
  keyOutputs: fc.array(safeTextArb, { minLength: 0, maxLength: 5 }),
  codeBlocks: fc.constant([]),
  lastExchanges: fc.array(exchangeArb, { minLength: 0, maxLength: 3 }),
  errorMessages: fc.array(safeTextArb, { minLength: 0, maxLength: 3 }),
  totalMessages: fc.nat({ max: 100 }),
  extractedAt: fc.constant(new Date().toISOString())
});

/**
 * Context with non-empty codeBlocks.
 */
const contextWithCodeArb = fc.record({
  sessionType: sessionTypeArb,
  platform: platformArb,
  goal: fc.oneof(safeTextArb, fc.constant('')),
  keyOutputs: fc.array(safeTextArb, { minLength: 0, maxLength: 5 }),
  codeBlocks: fc.array(safeTextArb, { minLength: 1, maxLength: 3 }),
  lastExchanges: fc.array(exchangeArb, { minLength: 0, maxLength: 3 }),
  errorMessages: fc.array(safeTextArb, { minLength: 0, maxLength: 3 }),
  totalMessages: fc.nat({ max: 100 }),
  extractedAt: fc.constant(new Date().toISOString())
});

describe('Prompt Builder Property-Based Tests', () => {
  describe('Property 4: Prompt Structure', () => {
    /**
     * **Validates: Requirements 8.1, 8.4, 8.5, 8.7, 8.8, 8.9, 8.10, 8.11**
     *
     * For any valid Session_Context:
     * - Always starts with [RELAY HANDOFF]
     * - Always ends with continuation instruction
     * - Goal section always present (with placeholder if empty)
     * - keyOutputs section always present (with placeholder if empty)
     * - lastExchanges section always present (with placeholder if empty)
     * - codeBlocks section present only when codeBlocks is non-empty
     */

    it('prompt always starts with [RELAY HANDOFF]', () => {
      fc.assert(
        fc.property(contextArb, (context) => {
          const prompt = buildHandoffPrompt(context);
          expect(prompt.startsWith('[RELAY HANDOFF]')).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    it('prompt always ends with continuation instruction', () => {
      fc.assert(
        fc.property(contextArb, (context) => {
          const prompt = buildHandoffPrompt(context);
          expect(prompt.trimEnd().endsWith(CONTINUATION_INSTRUCTION.trimEnd())).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    it('goal section is always present in the prompt', () => {
      fc.assert(
        fc.property(contextArb, (context) => {
          const prompt = buildHandoffPrompt(context);
          expect(prompt).toContain('## Goal');
          // Either the actual goal or "Not specified"
          if (!context.goal) {
            expect(prompt).toContain('Not specified');
          } else {
            expect(prompt).toContain(context.goal);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('keyOutputs section is always present in the prompt', () => {
      fc.assert(
        fc.property(contextArb, (context) => {
          const prompt = buildHandoffPrompt(context);
          expect(prompt).toContain('## Progress / Key Outputs');
          if (context.keyOutputs.length === 0) {
            expect(prompt).toContain('No outputs generated yet');
          }
        }),
        { numRuns: 200 }
      );
    });

    it('lastExchanges section is always present in the prompt', () => {
      fc.assert(
        fc.property(contextArb, (context) => {
          const prompt = buildHandoffPrompt(context);
          expect(prompt).toContain('## Recent Exchange');
          if (context.lastExchanges.length === 0) {
            expect(prompt).toContain('This is the first interaction');
          }
        }),
        { numRuns: 200 }
      );
    });

    it('codeBlocks section is omitted when codeBlocks is empty', () => {
      fc.assert(
        fc.property(contextNoCodeArb, (context) => {
          const prompt = buildHandoffPrompt(context);
          expect(prompt).not.toContain('## Last Code Output');
        }),
        { numRuns: 100 }
      );
    });

    it('codeBlocks section is present when codeBlocks is non-empty', () => {
      fc.assert(
        fc.property(contextWithCodeArb, (context) => {
          const prompt = buildHandoffPrompt(context);
          expect(prompt).toContain('## Last Code Output');
        }),
        { numRuns: 100 }
      );
    });

    it('prompt never exceeds 4000 characters', () => {
      // Generate contexts with potentially large content to test truncation
      const largeContextArb = fc.record({
        sessionType: sessionTypeArb,
        platform: platformArb,
        goal: fc.string({ minLength: 50, maxLength: 200 }),
        keyOutputs: fc.array(fc.string({ minLength: 100, maxLength: 500 }), { minLength: 0, maxLength: 10 }),
        codeBlocks: fc.array(fc.string({ minLength: 100, maxLength: 1000 }), { minLength: 0, maxLength: 3 }),
        lastExchanges: fc.array(
          fc.record({
            user: fc.string({ minLength: 10, maxLength: 200 }),
            assistant: fc.string({ minLength: 10, maxLength: 200 })
          }),
          { minLength: 0, maxLength: 3 }
        ),
        errorMessages: fc.constant([]),
        totalMessages: fc.nat({ max: 100 }),
        extractedAt: fc.constant(new Date().toISOString())
      });

      fc.assert(
        fc.property(largeContextArb, (context) => {
          const prompt = buildHandoffPrompt(context);
          expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LENGTH);
        }),
        { numRuns: 200 }
      );
    });

    it('section order is always: header, sessionType, source, goal, progress, code (if present), exchange, instruction', () => {
      fc.assert(
        fc.property(contextWithCodeArb, (context) => {
          const prompt = buildHandoffPrompt(context);

          const headerIdx = prompt.indexOf('[RELAY HANDOFF]');
          const sessionIdx = prompt.indexOf('Session Type:');
          const sourceIdx = prompt.indexOf('Source:');
          const goalIdx = prompt.indexOf('## Goal');
          const progressIdx = prompt.indexOf('## Progress / Key Outputs');
          const codeIdx = prompt.indexOf('## Last Code Output');
          const exchangeIdx = prompt.indexOf('## Recent Exchange');
          const instructionIdx = prompt.indexOf('---\nPlease acknowledge');

          expect(headerIdx).toBeLessThan(sessionIdx);
          expect(sessionIdx).toBeLessThan(sourceIdx);
          expect(sourceIdx).toBeLessThan(goalIdx);
          expect(goalIdx).toBeLessThan(progressIdx);
          expect(progressIdx).toBeLessThan(codeIdx);
          expect(codeIdx).toBeLessThan(exchangeIdx);
          expect(exchangeIdx).toBeLessThan(instructionIdx);
        }),
        { numRuns: 100 }
      );
    });
  });
});
