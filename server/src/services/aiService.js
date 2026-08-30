import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES, PRIORITIES } from '../config/constants.js';

const MODEL = process.env.AI_MODEL || 'claude-opus-5';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 15000);

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export const aiEnabled = Boolean(client);

// ---------------------------------------------------------------------------
// Validation — the AI is never trusted. Anything it returns is coerced into
// our enums or rejected before it can be stored.
// ---------------------------------------------------------------------------
function pickEnum(value, allowed) {
  if (typeof value !== 'string') return null;
  const hit = allowed.find((a) => a.toLowerCase() === value.trim().toLowerCase());
  return hit || null;
}

export function validateTriage(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('AI response was not an object');
  }
  const category = pickEnum(raw.category, CATEGORIES);
  const priority = pickEnum(raw.priority, PRIORITIES);
  const summary =
    typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 400) : '';

  if (!category || !priority || !summary) {
    throw new Error('AI response missing a valid category, priority, or summary');
  }
  return { category, priority, summary };
}

// ---------------------------------------------------------------------------
// Deterministic fallback — keyword scoring. Always available, no network.
// ---------------------------------------------------------------------------
const KEYWORDS = {
  Billing: ['charg', 'refund', 'payment', 'invoice', 'billed', 'subscription', 'price', 'card', 'overcharge'],
  Technical: ['error', 'bug', 'crash', 'broken', 'not working', 'fail', 'login', 'password', '500', 'loading'],
  Account: ['account', 'profile', 'email address', 'delete my', 'access', 'locked', 'verification'],
  Shipping: ['ship', 'delivery', 'package', 'tracking', 'arrive', 'courier', 'delayed', 'lost parcel'],
  Product: ['feature', 'how do i', 'product', 'defect', 'quality', 'missing part', 'damaged item'],
};

const HIGH_PRIORITY = ['charged twice', 'double charge', 'urgent', 'asap', 'immediately', 'fraud', 'unauthorized', 'cannot access', 'down', 'lost money', 'legal'];
const LOW_PRIORITY = ['question', 'wondering', 'suggestion', 'feedback', 'whenever', 'no rush', 'minor'];

export function mockTriage({ subject = '', description = '', requestedCategory } = {}) {
  const text = `${subject}\n${description}`.toLowerCase();

  let category = requestedCategory && CATEGORIES.includes(requestedCategory) ? requestedCategory : 'General';
  let best = 0;
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > best) {
      best = score;
      category = cat;
    }
  }

  let priority = 'Medium';
  if (HIGH_PRIORITY.some((w) => text.includes(w))) priority = 'High';
  else if (LOW_PRIORITY.some((w) => text.includes(w))) priority = 'Low';
  else if (category === 'Billing') priority = 'High';

  const firstSentence = description.split(/(?<=[.!?])\s/)[0] || subject || 'Customer request';
  const summary = `${category} issue: ${firstSentence.trim().slice(0, 160)}`;

  return { category, priority, summary };
}

// ---------------------------------------------------------------------------
// Claude triage with hard timeout + graceful degradation.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a support-ticket triage assistant.
Classify the customer's message and reply with ONLY a JSON object, no prose, no code fences.

Schema:
{
  "category": one of ${JSON.stringify(CATEGORIES)},
  "priority": one of ${JSON.stringify(PRIORITIES)},
  "summary": a single sentence (max ~25 words) describing the core issue for an agent
}

Guidance:
- "High" = money at risk, security/fraud, service fully unusable, or explicit urgency.
- "Low" = general questions, feedback, cosmetic issues.
- Everything else is "Medium".
- Prefer the customer's suggested category only if it fits the message.`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object in AI response');
  return JSON.parse(text.slice(start, end + 1));
}

export async function triageTicket({ subject, description, requestedCategory }) {
  const startedAt = Date.now();

  if (!client) {
    return {
      ...mockTriage({ subject, description, requestedCategory }),
      source: 'mock',
      model: null,
      error: 'ANTHROPIC_API_KEY not configured',
      generatedAt: new Date(),
    };
  }

  try {
    const userContent = [
      requestedCategory ? `Customer suggested category: ${requestedCategory}` : null,
      `Subject: ${subject}`,
      `Message: ${description}`,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 400,
        output_config: { effort: 'low' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      },
      { timeout: TIMEOUT_MS, maxRetries: 1 }
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('AI returned no text');

    const validated = validateTriage(extractJson(textBlock.text));
    return {
      ...validated,
      source: 'claude',
      model: response.model || MODEL,
      error: null,
      generatedAt: new Date(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Degrade — never block the ticket.
    return {
      ...mockTriage({ subject, description, requestedCategory }),
      source: 'fallback',
      model: MODEL,
      error: err.message || 'AI request failed',
      generatedAt: new Date(),
      latencyMs: Date.now() - startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Bonus: AI-generated resolution summary from the conversation.
// ---------------------------------------------------------------------------
export async function generateResolutionSummary({ subject, description, messages }) {
  const transcript = messages
    .map((m) => `${m.authorRole.toUpperCase()} (${m.authorName}): ${m.body}`)
    .join('\n');

  if (!client) {
    const lastAgent = [...messages].reverse().find((m) => m.authorRole === 'agent');
    return {
      summary:
        (lastAgent?.body || 'Issue addressed with the customer.').slice(0, 400),
      source: 'mock',
    };
  }

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 300,
        output_config: { effort: 'low' },
        system:
          'Write a concise 2-3 sentence resolution summary for a support ticket, ' +
          'stating the problem and how it was resolved. Reply with plain text only.',
        messages: [
          {
            role: 'user',
            content: `Subject: ${subject}\nOriginal issue: ${description}\n\nConversation:\n${transcript}`,
          },
        ],
      },
      { timeout: TIMEOUT_MS, maxRetries: 1 }
    );
    const textBlock = response.content.find((b) => b.type === 'text');
    return { summary: (textBlock?.text || '').trim().slice(0, 600), source: 'claude' };
  } catch (err) {
    const lastAgent = [...messages].reverse().find((m) => m.authorRole === 'agent');
    return {
      summary: (lastAgent?.body || 'Issue addressed with the customer.').slice(0, 400),
      source: 'fallback',
      error: err.message,
    };
  }
}
