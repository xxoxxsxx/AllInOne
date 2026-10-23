import { Suspense } from "react";
import type { Metadata } from "next";
import "./globals.css";

import { ToastHost } from "@/components/toast";

export const metadata: Metadata = {
  title: "CDK Ledger App",
  description: "Single-user CDK ledger for internal network use.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <Suspense fallback={null}>
          <ToastHost />
        </Suspense>
      </body>
    </html>
  );
}
