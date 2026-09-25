import { generateText, tool, type JSONValue, type ModelMessage } from "ai";

import { modelLabel, resolveModel } from "./model";
import { z } from "zod";

import { db } from "@/lib/db";
import { executorFor } from "./actions";
import { record } from "./audit";
import { idempotencyKey } from "./idempotency";
import { evaluatePolicy } from "./policy";
import { ActionTypeSchema, CONTACT_ACTIONS, ProposalSchema, type ActionType, type Proposal } from "./types";
import { agentSlots, getTemplate } from "@/lib/templates";

import type { Policy, Prisma } from "@/generated/prisma/client";

/**
 * The durable agent loop.
 *
 * Deliberately NOT the AI SDK's built-in multi-step loop. That one runs in
 * memory, which means a run cannot survive a crash and cannot stop half way to
 * wait for a human. This loop persists after every step, so:
 *
 *   - a crash resumes from the last committed step instead of starting over,
 *   - an action that needs sign-off parks the run in the database and returns,
 *   - a side effect is written before it fires, so a resume can tell the
 *     difference between "decided but never did" and "already did".
 *
 * That last distinction is the whole reason the loop is hand-written.
 */

export type RunOutcome =
  | { status: "COMPLETED"; runId: string; summary: string }
  | { status: "AWAITING_APPROVAL"; runId: string; actionId: string }
  | { status: "BLOCKED_BY_POLICY"; runId: string; blockedBy: string }
  | { status: "FAILED"; runId: string; error: string };

export async function advanceRun(runId: string): Promise<RunOutcome> {
  const run = await db.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      case: true,
      steps: { orderBy: { index: "asc" } },
      actions: true,
      tenant: { include: { policies: true } },
    },
  });

  if (run.status === "COMPLETED" || run.status === "FAILED") {
    return run.status === "COMPLETED"
      ? { status: "COMPLETED", runId, summary: "already complete" }
      : { status: "FAILED", runId, error: run.error ?? "unknown" };
  }

  const policy = run.tenant.policies[0];
  if (!policy) {
    return fail(runId, "Tenant has no policy row. Refusing to act without one.");
  }

  await db.agentRun.update({
    where: { id: runId },
    data: { status: "RUNNING" },
  });

  // Rebuild conversation state from committed steps. This is what makes a
  // resume identical to an uninterrupted run - the model sees the same history
  // either way, because the history lives in Postgres and not in this process.
  const messages = rebuildMessages(run.steps, run.case, run.tenant.name);
  let stepIndex = run.stepCount;
  let actionsTaken = run.actions.filter((a) => a.status === "EXECUTED").length;
  /**
   * Attempts spent on this case, advanced here as well as in the database.
   *
   * `run.case` was read once, before the loop. executeAction() increments the
   * row, so every proposal after the first contact in a run was being checked
   * and keyed against a count that had already moved - the per-case attempt
   * budget could not bind inside a single run, and the idempotency key of a
   * second message carried the first one's attempt number, which `pnpm replay`
   * then failed to re-derive because it reconstructs the count correctly.
   */
  let attemptCount = run.case.attemptCount;

  try {
    while (stepIndex < policy.maxRunSteps) {
      const started = Date.now();
      const result = await generateText({
        model: resolveModel(),
        system: systemPrompt(policy, run.tenant.name),
        messages,
        tools: agentTools,
      });
      const latencyMs = Date.now() - started;

      stepIndex = await commitStep(runId, stepIndex, {
        kind: "MODEL_CALL",
        model: modelLabel(),
        promptTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        latencyMs,
        content: result.text || null,
      });

      const calls = result.toolCalls ?? [];

      // No tool call means the agent believes it is done.
      if (calls.length === 0) {
        await commitStep(runId, stepIndex, {
          kind: "TERMINAL",
          content: result.text || "(no summary)",
        });
        await db.agentRun.update({
          where: { id: runId },
          data: { status: "COMPLETED", completedAt: new Date(), stepCount: stepIndex + 1 },
        });
        await record({
          tenantId: run.tenantId,
          entity: "run",
          entityId: runId,
          event: "completed",
          actor: "agent",
          data: { steps: stepIndex + 1 },
        });
        return { status: "COMPLETED", runId, summary: result.text };
      }

      messages.push(...stripReasoning(result.response.messages));

      for (const call of calls) {
        stepIndex = await commitStep(runId, stepIndex, {
          kind: "TOOL_CALL",
          toolName: call.toolName,
          toolArgs: call.input as Prisma.InputJsonValue,
        });

        if (call.toolName !== "propose_action") {
          // Read-only tools run immediately; nothing to gate.
          const output = await runReadOnlyTool(call.toolName, call.input, run.case);
          stepIndex = await commitStep(runId, stepIndex, {
            kind: "TOOL_RESULT",
            toolName: call.toolName,
            detail: output as Prisma.InputJsonValue,
          });
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: { type: "json", value: output as JSONValue },
              },
            ],
          });
          continue;
        }

        // ---- the gated path ----------------------------------------------
        const parsed = ProposalSchema.safeParse(call.input);
        if (!parsed.success) {
          const err = { error: "invalid_proposal", detail: parsed.error.message };
          messages.push(toolResult(call, err));
          continue;
        }
        const proposal: Proposal = parsed.data;

        const verdict = evaluatePolicy({
          proposal,
          policy,
          kase: { ...run.case, attemptCount },
          actionsThisRun: actionsTaken,
        });

        stepIndex = await commitStep(runId, stepIndex, {
          kind: "POLICY_CHECK",
          content: verdict.allowed ? "allowed" : `blocked: ${verdict.blockedBy}`,
          detail: { checks: verdict.checks } as Prisma.InputJsonValue,
        });

        if (!verdict.allowed) {
          await record({
            tenantId: run.tenantId,
            entity: "run",
            entityId: runId,
            event: "action_blocked",
            actor: "system",
            data: { type: proposal.type, blockedBy: verdict.blockedBy },
          });
          // Tell the model why, and let it choose something else. A blocked
          // action is information, not a crash.
          messages.push(
            toolResult(call, {
              blocked: true,
              by: verdict.blockedBy,
              checks: verdict.checks,
            }),
          );
          continue;
        }

        // WRITE-AHEAD. The row exists before the side effect does.
        const key = idempotencyKey({
          tenantId: run.tenantId,
          caseId: run.caseId,
          type: proposal.type,
          args: proposal.args,
          attempt: attemptCount,
        });

        const existing = await db.proposedAction.findUnique({
          where: { idempotencyKey: key },
        });
        if (existing) {
          // Same conclusion reached twice. Do not act again; report the first.
          messages.push(
            toolResult(call, {
              duplicate: true,
              previousStatus: existing.status,
              actionId: existing.id,
            }),
          );
          continue;
        }

        const action = await db.proposedAction.create({
          data: {
            runId,
            tenantId: run.tenantId,
            type: proposal.type,
            args: proposal.args as Prisma.InputJsonValue,
            reason: proposal.reason,
            valuePaise: proposal.valuePaise,
            idempotencyKey: key,
            status: verdict.requiresApproval ? "PROPOSED" : "APPROVED",
            autoApproved: !verdict.requiresApproval,
            policyVerdict: { checks: verdict.checks } as Prisma.InputJsonValue,
            decidedAt: verdict.requiresApproval ? null : new Date(),
          },
        });

        stepIndex = await commitStep(runId, stepIndex, {
          kind: "ACTION_PROPOSED",
          content: `${proposal.type}: ${proposal.reason}`,
          detail: { actionId: action.id, requiresApproval: verdict.requiresApproval },
        });
        await record({
          tenantId: run.tenantId,
          entity: "action",
          entityId: action.id,
          event: "proposed",
          actor: "agent",
          data: { type: proposal.type, autoApproved: !verdict.requiresApproval },
        });

        if (verdict.requiresApproval) {
          // Park. The run stops here and stays stopped until a human decides.
          await commitStep(runId, stepIndex, {
            kind: "AWAIT_APPROVAL",
            content: `Waiting on a human for ${proposal.type}.`,
            detail: { actionId: action.id },
          });
          await db.agentRun.update({
            where: { id: runId },
            data: {
              status: "AWAITING_APPROVAL",
              awaitingActionId: action.id,
              stepCount: stepIndex + 1,
            },
          });
          return { status: "AWAITING_APPROVAL", runId, actionId: action.id };
        }

        const exec = await executeAction(action.id, run.tenantId, run.caseId, run.arm === "CONTROL");
        actionsTaken += 1;
        // Mirrors exactly what executeAction() just wrote to the row.
        if (exec.ok && isContactType(action.type)) attemptCount += 1;
        stepIndex = await commitStep(runId, stepIndex, {
          kind: "ACTION_EXECUTED",
          content: exec.ok ? "executed" : `failed: ${exec.error}`,
          detail: exec as unknown as Prisma.InputJsonValue,
        });
        messages.push(toolResult(call, exec as unknown as Record<string, unknown>));
      }
    }

    // Step ceiling. Not an error - a budget, and hitting it is a finding.
    await db.agentRun.update({
      where: { id: runId },
      data: { status: "BLOCKED_BY_POLICY", completedAt: new Date(), stepCount: stepIndex },
    });
    return { status: "BLOCKED_BY_POLICY", runId, blockedBy: "max_run_steps" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(runId, message);
  }
}

/**
 * Executes an already-approved action. Separated from the loop so the approval
 * webhook can call it directly when a human signs off, without re-entering the
 * model at all.
 */
export async function executeAction(
  actionId: string,
  tenantId: string,
  caseId: string,
  dryRun: boolean,
) {
  const action = await db.proposedAction.findUniqueOrThrow({ where: { id: actionId } });

  if (action.status === "EXECUTED") {
    // Resume path: the write-ahead row says this already fired. Do not repeat.
    return { ok: true as const, data: { alreadyExecuted: true, ...(action.result as object) } };
  }
  if (action.status !== "APPROVED") {
    return { ok: false as const, error: `Action is ${action.status}, not APPROVED.` };
  }

  const executor = executorFor(ActionTypeSchema.parse(action.type));
  if (!executor) return { ok: false as const, error: `No executor for ${action.type}` };

  const result = await executor(action.args as Record<string, unknown>, {
    tenantId,
    caseId,
    dryRun,
  });

  await db.proposedAction.update({
    where: { id: actionId },
    data: {
      status: result.ok ? "EXECUTED" : "FAILED",
      executedAt: new Date(),
      result: result.ok ? (result.data as Prisma.InputJsonValue) : undefined,
      error: result.ok ? null : result.error,
    },
  });

  if (result.ok && isContactType(action.type)) {
    await db.case.update({
      where: { id: caseId },
      data: { attemptCount: { increment: 1 } },
    });
  }

  await record({
    tenantId,
    entity: "action",
    entityId: actionId,
    event: result.ok ? "executed" : "execution_failed",
    actor: "system",
    data: { type: action.type, dryRun },
  });

  return result;
}

// ---------------------------------------------------------------- tools

const agentTools = {
  propose_action: tool({
    description:
      "Propose an action against this case. The action is checked against tenant " +
      "policy and may require human approval before it happens. Proposing is not " +
      "doing - say plainly why the action is warranted. " +
      // Observed: the agent proposed send_email carrying { templateId, variables },
      // which policy correctly gated as irreversible free text - a wasted turn and
      // a trace that reads as confusion rather than judgement.
      //
      // Deliberately says nothing about which actions need approval. An earlier
      // wording mentioned that the free-text channels wait for a person, and the
      // agent read that as a reason to avoid them: three runs in a row took the
      // pre-approved template path where a human commitment was warranted. The
      // agent is not supposed to be optimising against the gate it cannot see.
      "send_templated_reply is the ONLY action that takes a templateId. The " +
      "free-text channels (send_email, send_sms) carry their own subject and body, " +
      "so a template id in one of those sends nothing.",
    inputSchema: z.object({
      type: ActionTypeSchema,
      args: z.record(z.string(), z.unknown()),
      reason: z.string().describe("Why this action, in one sentence, for a human reviewer."),
      valuePaise: z.number().int().min(0).default(0),
    }),
  }),
  read_case_history: tool({
    description: "Read prior contact attempts and outcomes for this case.",
    inputSchema: z.object({}),
  }),
};

async function runReadOnlyTool(
  name: string,
  _input: unknown,
  kase: { id: string; attemptCount: number; optedOut: boolean; payload: unknown },
): Promise<Record<string, unknown>> {
  if (name === "read_case_history") {
    const actions = await db.proposedAction.findMany({
      where: { run: { caseId: kase.id } },
      orderBy: { proposedAt: "asc" },
      select: { type: true, status: true, reason: true, proposedAt: true },
    });
    // Dates are stringified here, not left to the caller. A tool result becomes
    // part of the message history, and the AI SDK validates that history as
    // ModelMessage[] on the NEXT turn - a Date is not a JSONValue, so the run
    // dies with "The messages do not match the ModelMessage[] schema" the
    // second time the agent reads a case that already has an action. The first
    // read passes because the array is empty, which is why this survived.
    return {
      attemptCount: kase.attemptCount,
      optedOut: kase.optedOut,
      actions: actions.map((a) => ({ ...a, proposedAt: a.proposedAt.toISOString() })),
    };
  }
  return { error: `unknown tool ${name}` };
}

// ---------------------------------------------------------------- helpers

/**
 * The agent is told WHICH actions and templates exist, and nothing about the
 * rules governing them.
 *
 * That split is deliberate and it is the whole design. Naming the catalogue is
 * necessary - an agent guessing template ids proposes things that cannot exist,
 * gets refused, and escalates to a human every time, which is exactly what it
 * did before this list was here. But the CONDITIONS stay out: no contact
 * window, no attempt budget, no auto-approve list. Policy is enforced in
 * policy.ts against database rows, so a prompt injection has nothing to
 * subvert, and a blocked proposal is information the agent receives rather
 * than a rule it was trusted to remember.
 */
function systemPrompt(policy: Policy, businessName: string): string {
  const templates = policy.approvedTemplates
    .map((id) => {
      const template = getTemplate(id);
      if (!template) return null;
      // Only the slots the agent owns. business_name is filled from the tenant
      // row by the executor, so listing it would invite a guess at a value that
      // is about to be overwritten.
      const slots = agentSlots(template).join(", ") || "none";
      return `  ${template.id} (${template.channel}) - ${template.when}. Variables: ${slots}`;
    })
    .filter(Boolean);

  return [
    `You are an operations agent at ${businessName}, working one case at a time.`,
    // Sits with the agent's identity rather than inside the template block. As
    // three extra lines appended to that block it measurably raised how often
    // the agent chose a template at all, which is not what it was there to do.
    "Our name is filled into messages for you. Never write a company name",
    "into a message yourself, in a template or in free text.",
    "",
    "You do not perform actions. You propose them with propose_action, and a",
    "policy engine you cannot see or influence decides whether they happen.",
    "Some are executed automatically; the rest wait for a person.",
    "",
    `Actions available: ${ActionTypeSchema.options.join(", ")}.`,
    "",
    templates.length
      ? [
          "send_templated_reply is the only way to reach someone without a human",
          "reading your message first, and it only accepts these exact ids:",
          ...templates,
          "",
          'Pass { templateId, variables } as args. Use ONLY the variables listed',
          "for that template. Never invent a template id - an id that is not on",
          "this list will be refused.",
        ].join("\n")
      : "No message templates are approved, so you cannot contact anyone directly.",
    "",
    "If a proposal comes back blocked, that decision is final. Do not restate",
    "the same proposal in different words - choose a different action or stop.",
    "",
    "When nothing further is warranted, reply with a short plain summary of",
    "what you did and why, and call no tool.",
  ].join("\n");
}

function rebuildMessages(
  steps: Array<{ kind: string; content: string | null }>,
  kase: { subject: string; payload: unknown; timezone: string; contactName: string | null },
  businessName: string,
): ModelMessage[] {
  const opening: ModelMessage = {
    role: "user",
    content: [
      // Named here as well as in the system prompt because this is the message a
      // resumed run rebuilds from, and an agent that does not know which
      // business it answers for writes the wrong thing into its own reasoning
      // even when the executor fixes the message that goes out.
      `Business: ${businessName}`,
      `Case: ${kase.subject}`,
      kase.contactName ? `Contact: ${kase.contactName}` : null,
      `Recipient timezone: ${kase.timezone}`,
      `Details: ${JSON.stringify(kase.payload)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
  // Steps are replayed as context rather than as messages: the committed step
  // log is the source of truth, and reconstructing exact provider message
  // shapes across a resume is not worth the fragility.
  if (steps.length === 0) return [opening];
  const recap = steps
    .filter((s) => s.content)
    .map((s) => `[${s.kind}] ${s.content}`)
    .join("\n");
  return [opening, { role: "user", content: `Work already done on this case:\n${recap}` }];
}

/**
 * Removes reasoning parts from assistant messages before they are replayed.
 *
 * Reasoning models return their chain of thought as a content part, and the
 * SDK faithfully puts it on the assistant message. Sending that message back
 * on the next turn is rejected outright by providers that emit reasoning but
 * refuse it as input - Groq answers
 *   "for 'role:assistant' property 'reasoning_content' is unsupported"
 * and the run dies at step three, after the first tool result.
 *
 * Dropping it costs nothing: the reasoning was never ours to keep, the model
 * re-derives it each turn, and the decisions it led to are already recorded as
 * steps. An assistant message left with no content after the strip is dropped
 * rather than sent empty, which some providers also reject.
 */
function stripReasoning(messages: ModelMessage[]): ModelMessage[] {
  const cleaned: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      cleaned.push(message);
      continue;
    }

    const content = message.content.filter((part) => part.type !== "reasoning");
    if (content.length === 0) continue;
    cleaned.push({ ...message, content } as ModelMessage);
  }

  return cleaned;
}

function toolResult(
  call: { toolCallId: string; toolName: string },
  value: Record<string, unknown>,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json", value: value as JSONValue },
      },
    ],
  };
}

async function commitStep(
  runId: string,
  index: number,
  data: {
    kind: string;
    model?: string | null;
    promptTokens?: number | null;
    outputTokens?: number | null;
    latencyMs?: number | null;
    toolName?: string | null;
    toolArgs?: Prisma.InputJsonValue;
    content?: string | null;
    detail?: Prisma.InputJsonValue;
  },
): Promise<number> {
  await db.$transaction([
    db.runStep.create({
      data: {
        runId,
        index,
        kind: data.kind as never,
        model: data.model ?? null,
        promptTokens: data.promptTokens ?? null,
        outputTokens: data.outputTokens ?? null,
        latencyMs: data.latencyMs ?? null,
        toolName: data.toolName ?? null,
        toolArgs: data.toolArgs,
        content: data.content ?? null,
        detail: data.detail,
      },
    }),
    db.agentRun.update({ where: { id: runId }, data: { stepCount: index + 1 } }),
  ]);
  return index + 1;
}

async function fail(runId: string, error: string): Promise<RunOutcome> {
  await db.agentRun.update({
    where: { id: runId },
    data: { status: "FAILED", error, completedAt: new Date() },
  });
  return { status: "FAILED", runId, error };
}

/**
 * Executing one of these is what spends an attempt against the case budget.
 *
 * Shared with policy.ts rather than restated. When these were two lists they
 * disagreed about send_templated_reply, and the budget silently stopped binding
 * on the only path that reaches a customer with no human in the loop.
 */
function isContactType(type: string): boolean {
  return CONTACT_ACTIONS.has(type as ActionType);
}
