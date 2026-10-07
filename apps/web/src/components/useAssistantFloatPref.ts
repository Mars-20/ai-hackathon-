"use client";

import { useCallback, useEffect, useState } from "react";

// Float-open state: localStorage default (closed) + server pref sync.
// SSR-safe: window access only inside effects; first render is closed.

const LS_KEY = "assistant-float-open";

export function useAssistantFloatPref(loggedIn: boolean) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!loggedIn) {
      setReady(true);
      return;
    }
    let stored = false;
    try {
      stored = localStorage.getItem(LS_KEY) === "1";
    } catch {
      // storage unavailable — stay closed
    }
    void fetch("/api/assistant/prefs")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b && typeof b.float_enabled === "boolean") {
          setEnabled(b.float_enabled);
          setOpen(b.float_enabled && stored);
        }
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, [loggedIn]);

  const setOpenPersist = useCallback((next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(LS_KEY, next ? "1" : "0");
    } catch {
      // non-fatal
    }
  }, []);

  return { open, setOpen: setOpenPersist, enabled, ready };
}
