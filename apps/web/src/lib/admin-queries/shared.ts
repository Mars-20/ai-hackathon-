import "server-only";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
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
  const userClient = await createServerSupabaseClient();
  const service = createServiceRoleClient();
  return { admin, userClient, service };
}
