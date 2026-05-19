/**
 * Cloudflare Worker — Groq API Proxy for Relay Smart Summary (V2)
 *
 * POST /summarize
 * Body: { text: string, tier: "free" | "pro" }
 *
 * Forwards summarization requests to the Groq API.
 * No logging, no persistence.
 */

const MODELS = {
  free: 'llama-3.1-8b-instant',
  pro: 'llama-3.3-70b-versatile',
};

const SYSTEM_PROMPT = `You are a conversation summarizer for an AI chat handoff tool. A user hit their message limit on one AI platform and needs to continue their conversation on a different AI platform.

Given the conversation text, extract:
1. "goal" - What is the user's MAIN objective in this conversation? Be specific. (1-2 sentences)
2. "progress" - What has been accomplished so far? List the key outputs, sections completed, or decisions made. (array of 2-5 bullet points)
3. "blocker" - What was the user working on RIGHT NOW when the conversation ended? What should the next AI continue with? (1 sentence, be specific about what comes next)
4. "sessionType" - One of: "coding", "writing", "research", "general"

Output ONLY valid JSON with keys: goal, progress, blocker, sessionType. No markdown, no explanation.`;

const MAX_TEXT_LENGTH = 128000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Only accept POST /summarize
    if (request.method !== 'POST' || url.pathname !== '/summarize') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // Parse and validate request body
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    const { text, tier } = body;

    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid "text" field' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return new Response(JSON.stringify({ error: 'Text exceeds maximum length of 128,000 characters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (!tier || (tier !== 'free' && tier !== 'pro')) {
      return new Response(JSON.stringify({ error: 'Missing or invalid "tier" field. Must be "free" or "pro"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    const model = MODELS[tier];
    const apiKey = env.GROQ_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Service configuration error' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // Forward to Groq API
    try {
      const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          max_tokens: 800,
        }),
      });

      if (!groqResponse.ok) {
        return new Response(JSON.stringify({ error: 'Summarization service unavailable' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      const result = await groqResponse.json();
      const summary = result.choices?.[0]?.message?.content || '';

      return new Response(JSON.stringify({ summary, model }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch {
      return new Response(JSON.stringify({ error: 'Summarization service unavailable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  },
};
