"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Research-contact consent checkbox (Task 6, Egypt PDPL Section 11)
// - Rendered UNCHECKED by default (DEFAULT_CONSENT_CHECKED = false); the user
//   must opt in explicitly. Never default to true.
// - RESEARCH_CONSENT_TEXT is the exact consent text: shown verbatim in the
//   label AND stored verbatim as consent_text with consent_timestamp via
//   buildConsentRecord() when the user opts in.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";

/** Exact research-contact consent text (Arabic). Stored verbatim. */
export const RESEARCH_CONSENT_TEXT =
  "أوافق على التواصل البحثي واستلام رسائل البريد الإلكتروني لأغراض التحقق من الأفكار.";

/** Default checkbox state: unchecked (explicit opt-in required). */
export const DEFAULT_CONSENT_CHECKED = false as const;

export interface ConsentRecord {
  consent_given: true;
  consent_text: string;
  consent_timestamp: string;
}

/** Build the store-ready consent record, or null when not given. */
export function buildConsentRecord(given: boolean): ConsentRecord | null {
  if (!given) return null;
  return {
    consent_given: true,
    consent_text: RESEARCH_CONSENT_TEXT,
    consent_timestamp: new Date().toISOString(),
  };
}

export function ConsentCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor="research-consent-checkbox"
      className="flex items-start gap-2 text-xs text-slate-400 cursor-pointer"
    >
      <input
        id="research-consent-checkbox"
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-violet-500"
      />
      <span>{RESEARCH_CONSENT_TEXT}</span>
    </label>
  );
}

/** Self-managed variant (still unchecked by default). */
export function ResearchConsentField({ onConsent }: { onConsent: (v: boolean) => void }) {
  const [checked, setChecked] = useState<boolean>(DEFAULT_CONSENT_CHECKED);
  return (
    <ConsentCheckbox
      checked={checked}
      onChange={(v) => {
        setChecked(v);
        onConsent(v);
      }}
    />
  );
}
