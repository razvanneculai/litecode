import type { Config } from "../config/config.js";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  rateLimitRemaining: number | null;
}

export interface LLMResult {
  content: string;
  usage: LLMUsage;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── Rate limit helpers ────────────────────────────────────────────────────────

/**
 * Parse a reset-delay value into milliseconds.
 * Handles:
 *   - Plain float/int seconds: "7.056", "10"
 *   - Duration strings: "2s", "1m30s", "500ms", "1m30.5s"
 *   - ISO 8601 dates: "2025-01-01T00:00:00Z" (absolute timestamp)
 */
function parseResetDelayMs(value: string): number {
  if (!value) return 0;

  // ISO 8601 absolute timestamp (some providers use this)
  if (value.includes("T") && value.includes("Z")) {
    const delta = new Date(value).getTime() - Date.now();
    return delta > 0 ? delta : 0;
  }

  // Plain number — treat as seconds
  const asFloat = parseFloat(value);
  if (!isNaN(asFloat) && !/[a-zA-Z]/.test(value)) {
    return Math.ceil(asFloat * 1000);
  }

  // Duration string: "1m30.5s", "30s", "500ms"
  let ms = 0;
  const minuteMatch = value.match(/(\d+)m/);
  const secondMatch = value.match(/(\d+\.?\d*)s(?!$)/);    // "s" not at end (would be "ms")
  const secondMatchEnd = value.match(/(\d+\.?\d*)s$/);     // "s" at end
  const msMatch = value.match(/(\d+(?:\.\d+)?)ms/);

  if (minuteMatch) ms += parseInt(minuteMatch[1]) * 60_000;
  if (msMatch) ms += parseFloat(msMatch[1]);
  else if (secondMatch) ms += parseFloat(secondMatch[1]) * 1000;
  else if (secondMatchEnd) ms += parseFloat(secondMatchEnd[1]) * 1000;

  return ms > 0 ? Math.ceil(ms) : 0;
}

/**
 * Extract a retry wait time (ms) from a 429 error body.
 * Groq format: "Please try again in 7.056s"
 * Other formats: "retry after 5 seconds", "retry in 3s"
 * OpenRouter upstream: "Please retry shortly" → use a fixed short delay
 */
function parseBodyRetryMs(body: string): number | null {
  // Specific time mentioned
  const patterns = [
    /try again in (\d+\.?\d*)\s*s(?:ec(?:ond)?s?)?/i,
    /retry(?:\s+after)?\s+(\d+\.?\d*)\s*s(?:ec(?:ond)?s?)?/i,
    /wait\s+(\d+\.?\d*)\s*s(?:ec(?:ond)?s?)?/i,
    /available in (\d+\.?\d*)\s*s(?:ec(?:ond)?s?)?/i,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  }
  // Vague "retry shortly" — provider doesn't say how long, use 60s (free tier windows are ~1min)
  if (/retry shortly|try again shortly|temporarily.*rate.limit|rate.limit.*upstream/i.test(body)) {
    return 60_000;
  }
  return null;
}

/** Small random jitter to avoid synchronized retries from parallel executors */
function jitterMs(base = 300): number {
  return base + Math.floor(Math.random() * 400); // 300–700ms
}

// ─── Proactive rate-limit tracker ─────────────────────────────────────────────
//
// Most providers send x-ratelimit-remaining-requests / x-ratelimit-reset-requests
// on every successful 200 response. If we're about to exhaust the quota, sleep
// until the reset window opens — avoiding 429s entirely.
//
// Header name variations across providers:
//   Groq, OpenAI, Fireworks, DeepSeek:  x-ratelimit-remaining-requests
//   OpenRouter:                          x-ratelimit-remaining  (no -requests suffix)
//   Together AI:                         x-ratelimit-remaining
//
// Reset header format:
//   Groq, OpenAI:  relative duration  "2s", "1m30s"
//   OpenRouter:    Unix timestamp (integer seconds since epoch) or relative
//   DeepSeek:      ISO 8601 absolute timestamp
//   Together AI:   Unix timestamp

class RateLimitTracker {
  private remainingRequests = Infinity;
  private resetRequestsAt = 0; // absolute epoch ms

  /**
   * Read proactive headers from a successful response.
   * Call this after every 200 OK.
   */
  update(headers: Headers): void {
    // Remaining requests — try both naming conventions
    const remaining =
      headers.get("x-ratelimit-remaining-requests") ??
      headers.get("x-ratelimit-remaining") ??
      headers.get("X-RateLimit-Remaining");

    if (remaining !== null) {
      const n = parseInt(remaining);
      if (!isNaN(n)) this.remainingRequests = n;
    }

    // Reset time — try both naming conventions
    const reset =
      headers.get("x-ratelimit-reset-requests") ??
      headers.get("x-ratelimit-reset") ??
      headers.get("X-RateLimit-Reset");

    if (reset !== null) {
      // Unix timestamp (integer > 1e9) vs relative duration string
      const asInt = parseInt(reset);
      if (!isNaN(asInt) && asInt > 1_000_000_000) {
        // Unix seconds epoch
        this.resetRequestsAt = asInt * 1000;
      } else {
        this.resetRequestsAt = Date.now() + parseResetDelayMs(reset);
      }
    }
  }

  /**
   * If we're at the quota edge (≤ 1 request left), wait until the reset window.
   * This prevents the next call from hitting a 429.
   */
  async maybeThrottle(sleep: (ms: number) => Promise<void>): Promise<void> {
    if (this.remainingRequests <= 1 && this.resetRequestsAt > Date.now()) {
      const wait = this.resetRequestsAt - Date.now() + jitterMs(500);
      process.stderr.write(
        `[LLM] Proactive throttle: ${this.remainingRequests} requests left, ` +
        `waiting ${(wait / 1000).toFixed(1)}s for quota reset...\n`
      );
      await sleep(wait);
      this.remainingRequests = Infinity;
      this.resetRequestsAt = 0;
    }
  }
}

// Module-level singleton — shared across all calls in this process
const rateLimitTracker = new RateLimitTracker();

// ─── Main LLM call ─────────────────────────────────────────────────────────────

export async function callLLM(
  messages: Message[],
  config: Config,
  verbose = false
): Promise<LLMResult> {
  const url = `${config.provider.baseURL.replace(/\/$/, "")}/chat/completions`;

  if (verbose) {
    process.stderr.write(`[LLM] POST ${url} model=${config.provider.model}\n`);
    process.stderr.write(`[LLM] Request messages:\n${JSON.stringify(messages, null, 2)}\n`);
  }

  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  const doRequest = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      return await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.provider.apiKey}`,
        },
        body: JSON.stringify({
          model: config.provider.model,
          messages,
          stream: false,
          max_tokens: config.reservedOutputTokens,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  // Proactive throttle: if quota is nearly exhausted, wait before sending
  await rateLimitTracker.maybeThrottle(sleep);

  let res: Response | undefined;
  const MAX_NET_RETRIES = 5;   // network errors (timeout, DNS, etc.)
  const MAX_429_RETRIES = 10;  // rate limit retries — free tiers need more patience
  let rateRetries = 0;

  for (let attempt_n = 0; attempt_n <= MAX_NET_RETRIES; attempt_n++) {
    // ── Network-level errors (timeout, DNS, connection refused) ─────────────
    try {
      res = await doRequest();
    } catch (err) {
      if (attempt_n === MAX_NET_RETRIES) {
        throw new Error(`LLM request failed after ${MAX_NET_RETRIES} retries: ${(err as Error).message}`);
      }
      const delay = 3_000 * (attempt_n + 1) + jitterMs();
      process.stderr.write(`[LLM] Network error, retrying in ${(delay / 1000).toFixed(1)}s...\n`);
      await sleep(delay);
      continue;
    }

    // ── 429 Rate limited ─────────────────────────────────────────────────────
    if (res.status === 429) {
      const body = await res.text().catch(() => "");

      if (rateRetries >= MAX_429_RETRIES) {
        throw new Error(`LLM returned 429 after ${MAX_429_RETRIES} retries: ${body}`);
      }
      rateRetries++;

      let delay: number | undefined;

      // Priority 1: retry-after header (most providers)
      const retryAfterHeader =
        res.headers.get("retry-after") ??
        res.headers.get("Retry-After") ??
        res.headers.get("x-ratelimit-reset-after");

      if (retryAfterHeader) {
        const parsed = parseResetDelayMs(retryAfterHeader);
        if (parsed > 0) delay = parsed + jitterMs();
      }

      // Priority 2: error body (Groq: "Please try again in 7.056s")
      if (delay === undefined) {
        const bodyMs = parseBodyRetryMs(body);
        if (bodyMs !== null) delay = bodyMs + jitterMs();
      }

      // Priority 3: exponential backoff fallback
      if (delay === undefined) {
        delay = 10_000 * (attempt_n + 1) + jitterMs();
      }

      process.stderr.write(
        `[LLM] Rate limited (429), retrying in ${(delay / 1000).toFixed(1)}s...` +
        (retryAfterHeader ? ` (retry-after: ${retryAfterHeader})` : "") + "\n"
      );
      await sleep(delay);
      attempt_n--; // don't consume a network-retry slot for rate limit hits
      continue;
    }

    // ── 5xx server errors — short retry ──────────────────────────────────────
    if (res.status >= 500) {
      if (attempt_n === MAX_NET_RETRIES) {
        const body = await res.text().catch(() => "");
        throw new Error(`LLM returned ${res.status} after ${MAX_NET_RETRIES} retries: ${body}`);
      }
      const delay = 5_000 * (attempt_n + 1) + jitterMs();
      process.stderr.write(`[LLM] Server error ${res.status}, retrying in ${(delay / 1000).toFixed(1)}s...\n`);
      await sleep(delay);
      continue;
    }

    break;
  }

  res = res!;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM returned ${res.status}: ${body}`);
  }

  // ── Update proactive tracker from 200 response headers ───────────────────
  rateLimitTracker.update(res.headers);

  const rateLimitRemaining = (() => {
    const raw =
      res.headers.get("x-ratelimit-remaining-requests") ??
      res.headers.get("x-ratelimit-remaining") ??
      res.headers.get("X-RateLimit-Remaining");
    if (raw === null) return null;
    const n = parseInt(raw);
    return isNaN(n) ? null : n;
  })();

  const data = (await res.json()) as ChatCompletionResponse;
  // Some thinking models (Qwen3, DeepSeek-R1, etc.) put output in reasoning_content
  const msg = data.choices?.[0]?.message as Record<string, unknown> | undefined;
  const content =
    (msg?.["content"] as string | null | undefined) ||
    (msg?.["reasoning_content"] as string | null | undefined);
  if (!content) {
    throw new Error("LLM response missing choices[0].message.content");
  }

  if (verbose) {
    process.stderr.write(`[LLM] Response length: ${content.length} chars\n`);
    process.stderr.write(`[LLM] Response preview:\n${content.slice(0, 500)}...\n`);
  }

  const usage: LLMUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
    rateLimitRemaining,
  };

  return { content, usage };
}
