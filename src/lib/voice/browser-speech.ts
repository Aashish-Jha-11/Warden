"use client";

import type {
  VoiceFailure,
  VoiceFailureCode,
  VoiceProvider,
  VoiceStatus,
  VoiceSupport,
  VoiceTextHandler,
} from "./types";

/**
 * The Web Speech implementation of `VoiceProvider`.
 *
 * Everything awkward about this API is awkward here rather than in the console
 * component: the vendor prefix, the missing TypeScript types, the engine
 * stopping itself every few seconds of silence, and the fact that a laptop's
 * speakers feed straight back into its microphone.
 */

// ---------------------------------------------------------------- the API TS lacks
//
// lib.dom ships SpeechSynthesis* but not SpeechRecognition - it is still
// prefixed on the only engines that implement it - so the recogniser's shape is
// declared here, narrowly, rather than smuggled in behind `any`. These are
// module-scoped, so they cannot collide with a future lib.dom addition, and a
// property this file does not name is a property it does not touch.

type RecognitionAlternative = { readonly transcript: string; readonly confidence: number };

type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative | undefined;
};

type RecognitionResultList = {
  readonly length: number;
  readonly [index: number]: RecognitionResult | undefined;
};

type RecognitionEvent = {
  /** Where this event's news starts. Everything before it was already reported. */
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
};

type RecognitionErrorEvent = { readonly error: string; readonly message?: string };

interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognizerConstructor = new () => SpeechRecognizer;

function recognizerConstructor(): SpeechRecognizerConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognizerConstructor;
    webkitSpeechRecognition?: SpeechRecognizerConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function synthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return "speechSynthesis" in window ? window.speechSynthesis : null;
}

// ---------------------------------------------------------------- constants

/**
 * en-IN, not en-US. The people this product answers write and say things like
 * "fees kitni hai" and "2BHK in Kharadi"; Chrome's Indian English model keeps
 * those intact where the American one turns them into noise.
 */
const RECOGNITION_LANG = "en-IN";
const PREFERRED_VOICE_LANGS = ["en-IN", "en-GB", "en-US"] as const;

/** An end this soon after a start means the engine never really opened. */
const RAPID_END_MS = 300;
const MAX_RAPID_RESTARTS = 5;

/**
 * The failures worth interrupting someone over, and what to say about them.
 * Everything not listed is reported with the raw code rather than guessed at.
 */
const FAILURES: Record<string, VoiceFailure> = {
  "not-allowed": {
    code: "permission_denied",
    message:
      "Microphone access was blocked. Allow it for this site - the padlock in the address bar - and press the button again.",
  },
  "service-not-allowed": {
    code: "permission_denied",
    message:
      "This browser refused to start speech recognition. Check that microphone access is not blocked by a policy or an extension.",
  },
  "audio-capture": {
    code: "no_microphone",
    message: "No microphone was found. Plug one in or pick one in your system sound settings.",
  },
  network: {
    code: "network",
    message:
      "Speech recognition lost its connection. Chrome transcribes in the cloud, so it needs the network even though nothing else here does.",
  },
};

// ---------------------------------------------------------------- provider

export class BrowserSpeechProvider implements VoiceProvider {
  readonly label = "Web Speech API";

  private recognition: SpeechRecognizer | null = null;
  /** What the operator wants. Survives the engine restarting underneath it. */
  private wants = false;
  /** True while the agent is talking, when listening is off on purpose. */
  private suspended = false;
  private status: VoiceStatus = "idle";
  private startedAt = 0;
  private rapidRestarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private partialHandler: VoiceTextHandler | null = null;
  private finalHandler: VoiceTextHandler | null = null;
  private statusHandler: ((status: VoiceStatus) => void) | null = null;
  private failureHandler: ((failure: VoiceFailure) => void) | null = null;

  constructor() {
    // getVoices() is empty until the engine has loaded its list, and on Chrome
    // that happens after first paint. Asking now starts the load so the first
    // reply is spoken in an Indian English voice rather than whatever default
    // the engine reaches for while the real list is still arriving.
    synthesis()?.getVoices();
  }

  isSupported(): VoiceSupport {
    return browserSpeechSupport();
  }

  onPartial(handler: VoiceTextHandler): void {
    this.partialHandler = handler;
  }

  onFinal(handler: VoiceTextHandler): void {
    this.finalHandler = handler;
  }

  onStatus(handler: (status: VoiceStatus) => void): void {
    this.statusHandler = handler;
  }

  onFailure(handler: (failure: VoiceFailure) => void): void {
    this.failureHandler = handler;
  }

  async start(): Promise<void> {
    const support = this.isSupported();
    if (!support.supported) {
      this.fail(support.code, support.reason);
      return;
    }
    this.wants = true;
    this.rapidRestarts = 0;
    this.begin();
  }

  stop(): void {
    this.wants = false;
    this.clearRestart();
    this.discardRecognition();
    this.partialHandler?.("");
    if (!this.suspended) this.emit("idle");
  }

  async speak(text: string): Promise<void> {
    const spoken = text.trim();
    const synth = synthesis();
    // No synthesiser is not a failure worth reporting: the reply is on screen
    // either way, and this is the same browser that just transcribed fine.
    if (!spoken || !synth) return;

    // Listening is stopped, not ignored, for the duration. A recogniser left
    // running transcribes the agent's own reply out of the laptop speakers and
    // files it as the caller's next sentence.
    this.suspended = true;
    this.clearRestart();
    this.discardRecognition();
    this.emit("speaking");

    try {
      await play(synth, spoken, this.pickVoice());
    } finally {
      this.suspended = false;
      if (this.wants) this.begin();
      else this.emit("idle");
    }
  }

  dispose(): void {
    this.wants = false;
    this.clearRestart();
    this.discardRecognition();
    synthesis()?.cancel();
    this.partialHandler = null;
    this.finalHandler = null;
    this.statusHandler = null;
    this.failureHandler = null;
  }

  // -------------------------------------------------------------- internals

  private begin(): void {
    if (!this.wants || this.suspended || this.recognition) return;

    const Recognizer = recognizerConstructor();
    if (!Recognizer) return;

    // A fresh instance per session rather than one reused across restarts:
    // an aborted recogniser will sometimes refuse start() for the rest of the
    // page's life, and the object costs nothing.
    const recognition = new Recognizer();
    recognition.lang = RECOGNITION_LANG;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    // Each handler is closed over the instance that owns it, so a late event
    // from a session we have already walked away from is dropped instead of
    // restarting a mic the operator just closed.
    recognition.onresult = (event) => this.handleResult(recognition, event);
    recognition.onerror = (event) => this.handleError(recognition, event);
    recognition.onend = () => this.handleEnd(recognition);

    this.recognition = recognition;
    this.startedAt = Date.now();

    try {
      recognition.start();
    } catch {
      // start() throws if the engine is still winding down from the last
      // session. Nothing will fire onend for a start that never happened, so
      // the retry has to be scheduled from here - and counted here too, or an
      // engine that never accepts one would be retried for the life of the tab.
      this.recognition = null;
      this.rapidRestarts += 1;
      if (this.rapidRestarts >= MAX_RAPID_RESTARTS) {
        this.wants = false;
        this.fail(
          "unknown",
          "The speech engine would not start. Reload the page, and close any other tab that is using the microphone.",
        );
        return;
      }
      this.scheduleRestart(400);
      return;
    }

    this.emit("listening");
  }

  private handleResult(source: SpeechRecognizer, event: RecognitionEvent): void {
    if (this.recognition !== source) return;
    this.rapidRestarts = 0;

    let settled = "";
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const best = result?.[0];
      if (!result || !best) continue;
      if (result.isFinal) settled += (settled ? " " : "") + best.transcript.trim();
      else interim += best.transcript;
    }

    if (settled) this.finalHandler?.(settled);
    // Always emitted, including as "", so the interim line clears the moment a
    // phrase settles instead of leaving a ghost of it under the finished text.
    this.partialHandler?.(interim.trim());
  }

  private handleError(source: SpeechRecognizer, event: RecognitionErrorEvent): void {
    if (this.recognition !== source) return;

    // Both of these are routine. "no-speech" is a pause in the conversation and
    // "aborted" is us closing the mic on purpose; onend follows either one and
    // decides whether to pick listening back up.
    if (event.error === "no-speech" || event.error === "aborted") return;

    const known = FAILURES[event.error];
    if (known) {
      // Permission and hardware refusals do not get better by trying again, and
      // a retry loop against a denied mic is how a page ends up asking forever.
      this.wants = false;
      this.fail(known.code, known.message);
      return;
    }
    this.fail("unknown", `Speech recognition stopped: ${event.error}.`);
  }

  private handleEnd(source: SpeechRecognizer): void {
    if (this.recognition !== source) return;
    this.recognition = null;

    if (!this.wants || this.suspended) {
      if (!this.suspended) this.emit("idle");
      return;
    }

    // The engine ends the session itself after a few seconds of silence even
    // with continuous = true. That is not the end of the turn - the caller is
    // thinking - so listening resumes. An end that lands within a blink of the
    // start is a different animal: the device is gone, and restarting on that
    // signal forever is a spin.
    const instant = Date.now() - this.startedAt < RAPID_END_MS;
    this.rapidRestarts = instant ? this.rapidRestarts + 1 : 0;

    if (this.rapidRestarts >= MAX_RAPID_RESTARTS) {
      this.wants = false;
      this.fail(
        "no_microphone",
        "The microphone kept closing as soon as it opened. Check that another tab or app has not taken it.",
      );
      return;
    }

    this.scheduleRestart(instant ? 350 : 0);
  }

  private scheduleRestart(delayMs: number): void {
    this.clearRestart();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.begin();
    }, delayMs);
  }

  private clearRestart(): void {
    if (this.restartTimer === null) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private discardRecognition(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    this.recognition = null;

    // Handlers come off first: abort() fires onend, and an end belonging to a
    // discarded session must not schedule anything.
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;

    try {
      // abort(), not stop(). stop() keeps the capture indicator lit while it
      // waits to deliver one last result, and a mic light that stays on after
      // the operator let go is the wrong thing to show anybody.
      recognition.abort();
    } catch {
      // The instance is already unreachable; there is nothing left to release.
    }
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    const voices = synthesis()?.getVoices() ?? [];
    if (voices.length === 0) return null;

    for (const wanted of PREFERRED_VOICE_LANGS) {
      const match = voices.find((voice) => normaliseLang(voice.lang) === wanted.toLowerCase());
      if (match) return match;
    }
    return voices.find((voice) => normaliseLang(voice.lang).startsWith("en")) ?? null;
  }

  private emit(status: VoiceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusHandler?.(status);
  }

  private fail(code: VoiceFailureCode, message: string): void {
    if (!this.wants) this.emit("idle");
    this.failureHandler?.({ code, message });
  }
}

export function createBrowserVoice(): VoiceProvider {
  return new BrowserSpeechProvider();
}

let cachedSupport: VoiceSupport | null = null;

/**
 * The same answer `isSupported()` gives, without needing an instance.
 *
 * Memoised, and that is load-bearing rather than an optimisation: the console
 * reads this during render through useSyncExternalStore, which compares
 * snapshots by reference and re-renders forever if it is handed a fresh object
 * every time. Nothing it inspects can change while the page is open.
 */
export function browserSpeechSupport(): VoiceSupport {
  cachedSupport ??= detectSupport();
  return cachedSupport;
}

function detectSupport(): VoiceSupport {
  if (typeof window === "undefined") {
    return { supported: false, code: "unsupported", reason: "Speech runs in the browser." };
  }
  if (!recognizerConstructor()) {
    return {
      supported: false,
      code: "unsupported",
      reason:
        "This browser has no speech recogniser. Chrome, Edge and Brave on a desktop do; Firefox and Safari do not.",
    };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      code: "insecure_context",
      reason: "Microphone access needs HTTPS. This page is not on a secure origin.",
    };
  }
  return { supported: true };
}

// ---------------------------------------------------------------- synthesis

/** Some engines report "en_IN"; the spec says "en-IN". Treat them as one. */
function normaliseLang(lang: string): string {
  return lang.replace(/_/g, "-").toLowerCase();
}

/**
 * How long to wait before giving up on an utterance that never reports back.
 * Generous: cutting real speech short would let the mic reopen while the agent
 * is still talking, which is the exact feedback loop `speak()` exists to avoid.
 */
function backstopMs(text: string): number {
  return Math.min(120_000, 8_000 + text.length * 140);
}

function play(
  synth: SpeechSynthesis,
  text: string,
  voice: SpeechSynthesisVoice | null,
): Promise<void> {
  return new Promise((resolve) => {
    // Anything still queued belongs to a turn that has been superseded.
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice?.lang ?? RECOGNITION_LANG;
    if (voice) utterance.voice = voice;
    utterance.rate = 1.02;

    let done = false;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    let backstop: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (keepAlive !== null) clearInterval(keepAlive);
      if (backstop !== null) clearTimeout(backstop);
      resolve();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    // Chrome gives up on synthesis after roughly fifteen seconds unless the
    // engine is poked. resume() on a synth that is not paused is a no-op by the
    // spec and resets that timer in practice; without it, any reply longer than
    // a sentence or two is cut off mid-word.
    keepAlive = setInterval(() => synth.resume(), 10_000);
    backstop = setTimeout(() => {
      // A backgrounded tab can swallow onend entirely. Cancel rather than just
      // resolving, so listening never resumes on top of audio still playing.
      synth.cancel();
      finish();
    }, backstopMs(text));

    synth.speak(utterance);
  });
}
