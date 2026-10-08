// Never prerendered: the child page creates a Supabase browser client at
// render time, which requires runtime env that does not exist during
// `next build`. Segment config is ignored in "use client" files, so it
// lives here in this Server Component layout.
export const dynamic = "force-dynamic";

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
