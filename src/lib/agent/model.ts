import { google } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Which model the agent runs on, decided by whichever key is present.
 *
 * The runtime is provider-agnostic on purpose: the loop in runtime.ts is
 * hand-written and talks to the AI SDK's interface, not to any vendor. Swapping
 * providers is an env change, not a code change - which matters here because
 * the cheapest key available on a given day is not a design decision worth
 * rewriting a loop over.
 *
 * NON-NEGOTIABLE: the chosen model must support tool calling. The agent never
 * emits free text as an action - it calls propose_action and the policy engine
 * decides. A model without tool calling will appear to work, produce plausible
 * prose, and never actually do anything. Pick accordingly.
 */

export type Provider = "groq" | "google" | "openrouter";

/** Per-provider defaults. Override with WARDEN_MODEL for anything else. */
const DEFAULT_MODEL: Record<Provider, string> = {
  // Groq serves open models on its own hardware, and which ones a key can
  // reach changes without notice - `llama-3.3-70b-versatile` was the default
  // here until a `--list` showed it had been withdrawn. Verify any change with
  // `pnpm check:model`; list what a key reaches with `pnpm check:model --list`.
  //
  // Measured on this key: gpt-oss-120b 1.7s, gpt-oss-20b 1.0s, qwen3.8-27b
  // 0.6s, all returning tool calls. The largest is the default because the
  // agent loop is multi-step, and a model that reasons poorly costs more
  // round trips than it saves per call.
  groq: "openai/gpt-oss-120b",
  google: "gemini-2.5-flash",
  // OpenRouter serves hundreds of models and namespaces each by its publisher,
  // so there is no sensible default - set WARDEN_MODEL when using it.
  openrouter: "",
};

/** Providers that speak the OpenAI wire format, so one client covers them. */
const OPENAI_COMPATIBLE: Partial<Record<Provider, { baseURL: string; envKey: string }>> = {
  groq: { baseURL: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" },
};

export function openAICompatibleConfig(provider: Provider) {
  const config = OPENAI_COMPATIBLE[provider];
  if (!config) return null;
  return { ...config, apiKey: process.env[config.envKey] };
}

export function activeProvider(): Provider {
  // Explicit wins, so a machine holding several keys is still predictable.
  const forced = process.env.WARDEN_PROVIDER?.trim().toLowerCase();
  if (forced === "groq" || forced === "google" || forced === "openrouter") {
    return forced;
  }

  // Groq first: it is the fastest of these by a wide margin, and this product
  // is about answering someone while they are still holding the phone.
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "google";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";

  throw new Error(
    "No model key found. Set one of GROQ_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY " +
      "or OPENROUTER_API_KEY in .env, and optionally WARDEN_MODEL.",
  );
}

export function modelId(provider: Provider = activeProvider()): string {
  return process.env.WARDEN_MODEL?.trim() || DEFAULT_MODEL[provider];
}

export function resolveModel(): LanguageModel {
  const provider = activeProvider();
  const id = modelId(provider);

  switch (provider) {
    case "google":
      return google(id);

    case "groq":
    case "openrouter": {
      // Both speak the OpenAI wire format, so no dedicated provider package is
      // needed for either - one less dependency to track across AI SDK majors.
      const config = openAICompatibleConfig(provider)!;
      const client = createOpenAICompatible({
        name: provider,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        headers:
          provider === "openrouter"
            ? {
                // OpenRouter attributes requests by these; harmless if absent.
                "HTTP-Referer": process.env.WARDEN_PUBLIC_URL ?? "http://localhost:3000",
                "X-Title": "Warden",
              }
            : undefined,
      });
      return client(id);
    }
  }
}

/** For the run trace, so a step records which model actually answered. */
export function modelLabel(): string {
  const provider = activeProvider();
  return `${provider}:${modelId(provider)}`;
}
