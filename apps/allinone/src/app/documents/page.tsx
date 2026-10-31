import Link from "next/link";

import { getDocumentsDB, listCategories, listDocuments, listHolders, listTags } from "@/lib/documents/db";

import { DocumentsClient } from "./documents-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "证件夹",
};

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const initialStatus = status === "expiring" || status === "expired" || status === "valid" || status === "upcoming" ? status : "all";
  const db = getDocumentsDB();
  return (
    <main className="docs-page">
      <Link href="/" className="docs-back">← 工具箱</Link>
      <DocumentsClient
        initialStatus={initialStatus}
        documents={listDocuments(db)}
        holders={listHolders(db)}
        categories={listCategories(db)}
        tags={listTags(db)}
      />
    </main>
  );
}
