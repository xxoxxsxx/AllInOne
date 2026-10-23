import { Suspense } from "react";

import { ToastHost } from "@/components/ledger/toast";

// 台账段共享布局：挂载 ToastHost（原版根布局职责）。
export default function LedgerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <ToastHost />
      </Suspense>
    </>
  );
}
