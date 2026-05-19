// Relay Chrome Extension - Handoff Prompt Builder
// Constructs the structured handoff prompt from Session_Context

const MAX_PROMPT_LENGTH = 4000;

const CONTINUATION_INSTRUCTION = `---
Please acknowledge this context and continue directly from where we left off. Do not ask me to re-explain what I need.`;

/**
 * Build the Handoff Prompt from a Session_Context object.
 * Follows Requirement 8: fixed section order, max 4000 chars, truncation strategy.
 *
 * @param {object} context - Session_Context object
 * @returns {string} The formatted handoff prompt
 */
function buildHandoffPrompt(context) {
  const {
    sessionType = 'general',
    platform = 'unknown',
    goal = '',
    keyOutputs = [],
    codeBlocks = [],
    lastExchanges = []
  } = context || {};

  // Build sections in fixed order per Requirement 8 AC9:
  // header, sessionType, source platform, goal, progress summary,
  // last code output, recent exchange, closing instruction

  const header = '[RELAY HANDOFF]';
  const sessionLine = `Session Type: ${sessionType}`;
  const sourceLine = `Source: ${platform}`;

  // Goal section (Req 8 AC4, AC10)
  const goalSection = `\n## Goal\n${goal || 'Not specified'}`;

  // Progress / Key Outputs section (Req 8 AC5, AC11)
  let keyOutputsContent = keyOutputs.length > 0
    ? keyOutputs.slice(0, 10).join('\n')
    : 'No outputs generated yet';
  let progressSection = `\n## Progress / Key Outputs\n${keyOutputsContent}`;

  // Last Code Output section (Req 8 AC6) - omit entirely if codeBlocks is empty
  let codeSection = '';
  if (codeBlocks.length > 0) {
    const lastCode = codeBlocks[codeBlocks.length - 1];
    codeSection = `\n## Last Code Output\n${lastCode}`;
  }

  // Recent Exchange section (Req 8 AC7, AC12)
  let exchangeSection;
  if (lastExchanges.length > 0) {
    const lastExchange = lastExchanges[lastExchanges.length - 1];
    exchangeSection = `\n## Recent Exchange\nUser: ${lastExchange.user}\nAI: ${lastExchange.assistant}`;
  } else {
    exchangeSection = '\n## Recent Exchange\nThis is the first interaction';
  }

  // Assemble prompt
  let prompt = [
    header,
    sessionLine,
    sourceLine,
    goalSection,
    progressSection,
    codeSection,
    exchangeSection,
    '\n' + CONTINUATION_INSTRUCTION
  ].join('\n');

  // Truncation strategy (Req 8 AC14): if > 4000 chars,
  // truncate keyOutputs (oldest first) and codeBlocks (from middle)
  if (prompt.length > MAX_PROMPT_LENGTH) {
    prompt = truncatePrompt(context, header, sessionLine, sourceLine, goalSection, exchangeSection);
  }

  return prompt;
}

/**
 * Truncation strategy: remove keyOutputs oldest-first, then truncate code block
 * from middle preserving first 20 and last 20 lines.
 */
function truncatePrompt(context, header, sessionLine, sourceLine, goalSection, exchangeSection) {
  const {
    keyOutputs = [],
    codeBlocks = []
  } = context;

  let truncatedOutputs = keyOutputs.slice(0, 10);
  let lastCode = codeBlocks.length > 0 ? codeBlocks[codeBlocks.length - 1] : '';

  // First pass: truncate code block from middle (preserve first 20 + last 20 lines)
  if (lastCode) {
    const lines = lastCode.split('\n');
    if (lines.length > 40) {
      const first20 = lines.slice(0, 20).join('\n');
      const last20 = lines.slice(-20).join('\n');
      lastCode = first20 + '\n... [truncated] ...\n' + last20;
    }
  }

  // Second pass: remove keyOutputs oldest-first until within limit
  let prompt = assemblePrompt(header, sessionLine, sourceLine, goalSection, truncatedOutputs, lastCode, exchangeSection);

  while (prompt.length > MAX_PROMPT_LENGTH && truncatedOutputs.length > 0) {
    truncatedOutputs.shift(); // Remove oldest
    prompt = assemblePrompt(header, sessionLine, sourceLine, goalSection, truncatedOutputs, lastCode, exchangeSection);
  }

  // If still over limit after removing all keyOutputs, truncate code further
  if (prompt.length > MAX_PROMPT_LENGTH && lastCode) {
    lastCode = '';
    prompt = assemblePrompt(header, sessionLine, sourceLine, goalSection, truncatedOutputs, lastCode, exchangeSection);
  }

  return prompt;
}

/**
 * Assemble the prompt from pre-built sections.
 */
function assemblePrompt(header, sessionLine, sourceLine, goalSection, keyOutputs, lastCode, exchangeSection) {
  const keyOutputsContent = keyOutputs.length > 0
    ? keyOutputs.join('\n')
    : 'No outputs generated yet';
  const progressSection = `\n## Progress / Key Outputs\n${keyOutputsContent}`;

  let codeSection = '';
  if (lastCode) {
    codeSection = `\n## Last Code Output\n${lastCode}`;
  }

  return [
    header,
    sessionLine,
    sourceLine,
    goalSection,
    progressSection,
    codeSection,
    exchangeSection,
    '\n' + CONTINUATION_INSTRUCTION
  ].join('\n');
}

// Export for use by injector and tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildHandoffPrompt, MAX_PROMPT_LENGTH, CONTINUATION_INSTRUCTION };
}
