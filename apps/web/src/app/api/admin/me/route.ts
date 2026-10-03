// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/me → { tier } (Task 6 extension, accepted pre-flight).
// Lightweight tier lookup so the admin layout can hide platform-only nav
// (Ops) for the workspace tier. Returns the tier only — no user list, no
// secrets. Errors use the admin-only envelope { error, code }.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";

export async function GET() {
  try {
    const admin = await requireAdminFromSupabase();
    return NextResponse.json({ tier: admin.tier });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
