"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import type { AssistantThread } from "@/lib/assistant/types";

// D9: the panel mounts client-only (dynamic ssr:false) so SSR HTML is a
// skeleton and no hydration mismatch is possible. Initial threads arrive
// as serialized props from the server page.

const Panel = dynamic(() => import("./AssistantPanel"), {
  ssr: false,
  loading: () => <PanelSkeleton />,
});

function PanelSkeleton() {
  const tAsst = useTranslations("assistant");
  return (
    <div className="glass rounded-2xl p-10 text-center border border-white/5">
      <p className="text-slate-500 text-sm shimmer">{tAsst("view.loading")}</p>
    </div>
  );
}

export default function AssistantView({
  initialThreads,
}: {
  initialThreads: AssistantThread[];
}) {
  return <Panel initialThreads={initialThreads} />;
}
