"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Thin React hook around the browser's Web Speech API. Client-only.
 *
 * Design choices:
 *   - `continuous: true` so a sales call's worth of speech doesn't stop
 *     after every pause. Chrome still auto-stops after ~30s of silence;
 *     we auto-restart in `onend` as long as the caller's `intendActive`
 *     flag is true.
 *   - Interim results are surfaced to the caller for inline "Listening:
 *     ..." feedback, but only FINAL results flow through `onFinal` (which
 *     is where the transcript ingest POST happens — we don't want to
 *     spam the triage layer with half-formed sentences).
 *   - Errors are normalized to a string the UI can render. "no-speech"
 *     and "aborted" are benign (user paused / hit stop), we don't
 *     surface those — only genuine failures like `not-allowed` (mic
 *     permission denied) or `network`.
 */

type RecognitionErrorEvent = { error: string; message?: string };
interface RecognitionResult {
  0: { transcript: string };
  isFinal: boolean;
}
interface RecognitionResultList {
  length: number;
  [index: number]: RecognitionResult;
}
interface RecognitionEvent {
  resultIndex: number;
  results: RecognitionResultList;
}
interface RecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
interface RecognitionCtor {
  new (): RecognitionInstance;
}

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseSpeechRecognitionOptions {
  /** Called every time the engine emits a final (stable) transcript chunk. */
  onFinal: (text: string) => void;
  /** Called as the user is still speaking — useful for a "Listening: ..."
   *  inline preview. Called with an empty string when the interim clears. */
  onInterim?: (text: string) => void;
  /** BCP-47 language tag. Defaults to en-US. */
  lang?: string;
}

export interface UseSpeechRecognitionResult {
  supported: boolean;
  listening: boolean;
  /** Null when no error, a short user-facing message otherwise. */
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useSpeechRecognition(
  opts: UseSpeechRecognitionOptions
): UseSpeechRecognitionResult {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable refs — used inside recognition handlers (which don't capture
  // state updates between restarts).
  const recRef = useRef<RecognitionInstance | null>(null);
  const intendActiveRef = useRef(false);
  const onFinalRef = useRef(opts.onFinal);
  const onInterimRef = useRef(opts.onInterim);
  useEffect(() => { onFinalRef.current = opts.onFinal; }, [opts.onFinal]);
  useEffect(() => { onInterimRef.current = opts.onInterim; }, [opts.onInterim]);

  useEffect(() => {
    setSupported(Boolean(getRecognitionCtor()));
  }, []);

  const buildRecognition = useCallback((): RecognitionInstance | null => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = opts.lang ?? "en-US";

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const text = r[0].transcript;
        if (r.isFinal) {
          if (text.trim()) onFinalRef.current(text.trim());
        } else {
          interim += text;
        }
      }
      onInterimRef.current?.(interim);
    };

    rec.onerror = (e) => {
      // Benign — fires whenever a pause in speech coincides with the engine
      // wanting to restart. Handled by onend's auto-restart; don't alarm
      // the user.
      if (e.error === "no-speech" || e.error === "aborted") return;
      const msg =
        e.error === "not-allowed"
          ? "Mic permission denied — enable microphone access for this site to transcribe."
          : e.error === "network"
            ? "Speech recognition network error — will keep retrying."
            : `Speech recognition error: ${e.error}`;
      setError(msg);
    };

    rec.onend = () => {
      // Chrome auto-stops after silence / every ~30s. If we still intend
      // to be active, restart on the next tick (can't call start()
      // synchronously from inside onend).
      if (intendActiveRef.current) {
        setTimeout(() => {
          try {
            rec.start();
          } catch {
            /* already started — race with the tick; safe to ignore */
          }
        }, 50);
      } else {
        setListening(false);
      }
    };

    return rec;
  }, [opts.lang]);

  const start = useCallback(() => {
    setError(null);
    if (!supported) {
      setError("This browser doesn't support speech recognition. Try Chrome or Edge.");
      return;
    }
    if (listening) return; // already going

    intendActiveRef.current = true;
    const rec = buildRecognition();
    if (!rec) return;
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start microphone.";
      setError(msg);
      intendActiveRef.current = false;
    }
  }, [supported, listening, buildRecognition]);

  const stop = useCallback(() => {
    intendActiveRef.current = false;
    const rec = recRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    onInterimRef.current?.("");
    setListening(false);
  }, []);

  // Safety: if the component unmounts while listening, abort cleanly.
  useEffect(() => {
    return () => {
      intendActiveRef.current = false;
      try {
        recRef.current?.abort();
      } catch {
        /* noop */
      }
    };
  }, []);

  return { supported, listening, error, start, stop };
}
