/**
 * The voice seam.
 *
 * Warden's voice front door runs on the browser's own Web Speech API, and that
 * is a product decision rather than a shortcut: there is no API key to leak or
 * expire mid-judging, no per-minute cost, no vendor account a judge cannot
 * reach, no third party between the mic and the run - and Indian telephony
 * needs DLT registration that does not exist inside a hackathon window. The
 * demo works from the deployed URL on a laptop with nothing installed.
 *
 * This interface exists so that stays a decision and not a dependency. A
 * telephony or realtime provider is a second implementation of `VoiceProvider`
 * and nothing in `voice-console.tsx` changes. That is not speculative
 * generality: the moment this product has real customers it needs a phone
 * number, and the browser cannot answer one.
 *
 * Handlers are registered rather than passed to `start()` because a run of
 * speech outlives any one listening session - the recogniser restarts itself
 * several times inside a single utterance - and the UI must not lose its
 * subscription each time that happens.
 */

export type VoiceFailureCode =
  | "unsupported"
  | "insecure_context"
  | "permission_denied"
  | "no_microphone"
  | "network"
  | "unknown";

export type VoiceFailure = {
  code: VoiceFailureCode;
  /** Written for the person at the mic, not for a log. */
  message: string;
};

/**
 * `speaking` is a distinct state rather than a flag on `listening` because the
 * recogniser is deliberately off while the agent talks - see browser-speech.ts.
 */
export type VoiceStatus = "idle" | "listening" | "speaking";

export type VoiceTextHandler = (text: string) => void;

export type VoiceSupport =
  | { supported: true }
  | { supported: false; code: VoiceFailureCode; reason: string };

export interface VoiceProvider {
  /** Shown in the UI so it is never a mystery what is doing the listening. */
  readonly label: string;

  /** Cheap, synchronous, and safe to call during render on the client. */
  isSupported(): VoiceSupport;

  /** Words as they are being recognised. Replaced wholesale on every call. */
  onPartial(handler: VoiceTextHandler): void;
  /** A settled phrase. Appended, never replaced. */
  onFinal(handler: VoiceTextHandler): void;
  onStatus(handler: (status: VoiceStatus) => void): void;
  onFailure(handler: (failure: VoiceFailure) => void): void;

  /** Opens the mic. Rejects nothing - failures arrive through onFailure. */
  start(): Promise<void>;
  /** Closes the mic and releases the capture indicator. */
  stop(): void;
  /** Resolves when the utterance has finished playing, or was cut short. */
  speak(text: string): Promise<void>;

  /** Tear-down for unmount. Safe to call twice. */
  dispose(): void;
}

// ---------------------------------------------------------------- transcript

export type TranscriptSpeaker = "caller" | "agent";

export type TranscriptTurn = {
  id: string;
  speaker: TranscriptSpeaker;
  text: string;
  /** Epoch ms. Rendered client-side only, so it never has to match a server pass. */
  at: number;
  /** Agent turns only - the run's status at the moment it said this. */
  runStatus?: RunStatusValue;
};

// ---------------------------------------------------------------- wire types

/**
 * Mirrors Prisma's RunStatus. Spelled out rather than imported so this module
 * stays free of anything that only resolves on the server - it is shared by the
 * route handler and by a "use client" component, and over JSON these are
 * strings anyway.
 */
export type RunStatusValue =
  | "PENDING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED_BY_POLICY";

export type VoiceTurnRequest = {
  /** Omitted on the first turn - the route opens a case from what was said. */
  caseId?: string;
  transcript: string;
};

/** The proposal a run parked on, flattened for the client. */
export type VoiceTurnAction = {
  id: string;
  type: string;
  status: string;
  /** The agent's own justification, shown verbatim to the approver. */
  reason: string;
  valuePaise: number;
};

/**
 * A proposal policy refused during this turn, read back out of the committed
 * step log rather than remembered in the request.
 *
 * This is the thesis made visible on the one screen where a person is watching
 * in real time: the agent wanted to do something, a rule it cannot see said no,
 * and it carried on. Violet on screen, never red - a refusal here is the
 * product working.
 */
export type VoiceTurnBlock = {
  /** The policy check that refused it, e.g. "contact_window". */
  check: string;
  /** Policy's own wording, shown verbatim. */
  detail: string;
  /** What it refused. Null when the step log has no proposal beside the check. */
  actionType: string | null;
};

export type VoiceTurnData = {
  caseId: string;
  subject: string;
  runId: string;
  runStatus: RunStatusValue;
  /** Spoken aloud and shown as text. Both, always. */
  reply: string;
  /** Present only when the run stopped for a human. */
  awaitingAction: VoiceTurnAction | null;
  /** Everything policy stopped this turn, oldest first. Usually empty. */
  blocked: VoiceTurnBlock[];
  /** Wall clock for the whole turn, including the model. Shown as an instrument reading. */
  latencyMs: number;
  /** Committed run steps after this turn. */
  steps: number;
};

export type VoiceTurnResponse =
  | { ok: true; data: VoiceTurnData }
  | { ok: false; error: string };
