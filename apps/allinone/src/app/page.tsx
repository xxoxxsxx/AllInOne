import { HomeView } from "@/components/home-view";
import { loadCatalog } from "@/lib/tools";
import { documentsSummary, getDocumentsDB } from "@/lib/documents/db";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const { tools, categories, error } = loadCatalog();
  let documentSummary = null;
  let documentReminderError = false;
  if (tools.some((tool) => tool.id === "documents")) {
    try {
      documentSummary = documentsSummary(getDocumentsDB());
    } catch (error) {
      console.error("证件到期提醒读取失败", error);
      documentReminderError = true;
    }
  }
  return <HomeView tools={tools} categories={categories} loadError={error} documentSummary={documentSummary} documentReminderError={documentReminderError} />;
}
