// Never prerendered: the child page forwards request cookies to the
// companion API, which requires runtime request context that does not
// exist during `next build` (dashboard/validate layout precedent).
export const dynamic = "force-dynamic";

export default function MemoriesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
