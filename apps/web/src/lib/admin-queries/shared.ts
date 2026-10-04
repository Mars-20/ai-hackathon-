import "server-only";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
  getRequestServiceClient,
  getRequestUserClient,
} from "@/lib/supabase/server";
import type { RequireAdminResult } from "@/lib/admin";

export interface AdminQueryDeps {
  admin: RequireAdminResult;
  userClient: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  service: ReturnType<typeof createServiceRoleClient>;
}

export async function createQueryDeps(
  admin: RequireAdminResult,
): Promise<AdminQueryDeps> {
  // Request-shared clients (see server.ts): one user client + one service
  // client per request no matter how many DAL reads fan out.
  const userClient = await getRequestUserClient();
  const service = await getRequestServiceClient();
  return { admin, userClient, service };
}
