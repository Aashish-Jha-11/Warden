/**
 * pnpm check:model
 *
 * Proves the configured model can do the ONE thing this whole system depends
 * on: return a tool call.
 *
 * Warden's agent never emits free text as an action - it calls propose_action
 * and the policy engine decides. A model without working tool calling will
 * produce confident, plausible prose and never actually do anything, and the
 * failure looks like "the agent decided not to act" rather than like a bug.
 * That is a miserable thing to discover during a demo, so we find out here.
 */
import "dotenv/config";
import { generateText, tool } from "ai";
import { z } from "zod";

import {
  activeProvider,
  modelId,
  openAICompatibleConfig,
  resolveModel,
} from "../src/lib/agent/model";
import { ActionTypeSchema } from "../src/lib/agent/types";

const line = (s = "") => console.log(s);

async function main() {
  let provider: string;
  let id: string;
  try {
    provider = activeProvider();
    id = modelId();
  } catch (err) {
    line(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  line();
  line(`provider  ${provider}`);
  line(`model     ${id}`);
  line("-".repeat(58));

  // `--list` asks the provider what it will actually serve this key, which
  // beats guessing at model ids from documentation that moves faster than it
  // is published. Only the OpenAI-compatible providers expose it this way.
  if (process.argv.includes("--list")) {
    const config = openAICompatibleConfig(provider as never);
    if (!config) {
      line(`${provider} does not expose a model list over this API. Skipping.`);
    } else {
      try {
        const res = await fetch(`${config.baseURL}/models`, {
          headers: { Authorization: `Bearer ${config.apiKey ?? ""}` },
        });
        const body = (await res.json()) as { data?: Array<{ id?: string }> };
        const ids = (body.data ?? []).map((m) => m.id).filter(Boolean).sort();
        line(`${ids.length} models reachable with this key:`);
        for (const m of ids) line(`  ${m}`);
      } catch (err) {
        line(`could not list models: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    line("-".repeat(58));
  }

  const started = Date.now();
  let result;
  try {
    result = await generateText({
      model: resolveModel(),
      // Deliberately a case the model cannot answer in prose: it has no way to
      // know the window, so the only correct move is to call the tool.
      system:
        "You are an operations agent. You never act directly. To do anything " +
        "at all you must call propose_action. Never reply in prose.",
      prompt:
        "A new lead just messaged asking about weekend batch fees. " +
        "Send them the first_reply_v1 template.",
      tools: {
        propose_action: tool({
          description: "Propose an action for the policy engine to rule on.",
          // The REAL enum, not a loose string. Providers differ on whether
          // they enforce an enum in a tool schema or merely suggest it, and a
          // model that invents an action name costs the runtime a wasted round
          // trip on every single turn while it is told the proposal is invalid.
          // A check that accepts any string would not notice that.
          inputSchema: z.object({
            type: ActionTypeSchema,
            reason: z.string(),
          }),
        }),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    line(`✗ request failed`);
    line(`  ${message}`);
    line();
    line("Common causes:");
    line("  - wrong model id for this provider (check the provider's model list)");
    line("  - key not valid for this provider, or out of free quota");
    line("  - model exists but is not served to free-tier keys");
    process.exit(1);
  }

  const ms = Date.now() - started;
  const calls = result.toolCalls ?? [];

  line(`latency   ${ms}ms`);
  line(
    `tokens    ${result.usage?.inputTokens ?? "?"} in / ${result.usage?.outputTokens ?? "?"} out`,
  );
  line(`finish    ${result.finishReason}`);
  line("-".repeat(58));

  if (calls.length === 0) {
    line("✗ NO TOOL CALL - this model will not work for Warden.");
    line();
    line(`It replied in prose instead:`);
    line(`  "${(result.text || "(empty)").slice(0, 200)}"`);
    line();
    line("Pick a model that supports tool/function calling and try again.");
    process.exit(1);
  }

  line(`✓ tool call returned: ${calls.map((c) => c.toolName).join(", ")}`);
  for (const call of calls) {
    line(`  ${JSON.stringify(call.input)}`);
  }

  // Does it respect the enum, or invent a plausible-sounding action name?
  const proposed = calls
    .map((c) => (c.input as { type?: unknown })?.type)
    .filter((t): t is string => typeof t === "string");
  const invented = proposed.filter((t) => !ActionTypeSchema.options.includes(t as never));

  line();
  if (invented.length > 0) {
    line(`⚠ INVENTED ACTION TYPE: ${invented.join(", ")}`);
    line("  This provider treats the tool schema's enum as a suggestion.");
    line("  The runtime rejects these and tells the model to try again, so it");
    line("  still works - but every turn costs an extra round trip. Consider");
    line(`  a different model. Valid: ${ActionTypeSchema.options.join(", ")}`);
    line();
  } else {
    line("✓ respected the action-type enum - no wasted round trips.");
    line();
  }
  line("This model works. Warden's runtime will function on it.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
