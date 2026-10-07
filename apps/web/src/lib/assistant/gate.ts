// Closed-rollout gate for Assistant Chat (spec §10/§11).
// Edge-safe (pure string compare — importable from middleware).
// Order: auth FIRST (401 contract preserved), gate second (404 for
// signed-in users while closed). The gate is a product switch, not a
// security boundary — RLS + auth remain the security.

export function isAssistantOpen(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.ASSISTANT_OPEN_CHAT === "true";
}

export function assistantClosedResponse(): Response {
  return Response.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
}
