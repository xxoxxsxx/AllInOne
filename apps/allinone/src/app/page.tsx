import { HomeView } from "@/components/home-view";
import { loadCatalog } from "@/lib/tools";
import { documentsSummary, getDocumentsDB } from "@/lib/documents/db";
import { getFilmDb, listRolls } from "@/lib/filmlog/store";

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
  let filmSummary: { expired: number; soon: number } | null = null;
  if (tools.some(tool => tool.id === "filmlog")) {
    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const cutoff = Date.parse(`${today}T00:00:00Z`);
      const rolls = listRolls(getFilmDb()).filter(r => r.status === "stock" && r.expiresAt);
      filmSummary = { expired: rolls.filter(r => Date.parse(`${r.expiresAt}T00:00:00Z`) < cutoff).length,
        soon: rolls.filter(r => { const days = (Date.parse(`${r.expiresAt}T00:00:00Z`) - cutoff) / 86400000; return days >= 0 && days <= 183; }).length };
    } catch (error) { console.error("胶卷库存读取失败", error); }
  }
  return <HomeView tools={tools} categories={categories} loadError={error} documentSummary={documentSummary} documentReminderError={documentReminderError} filmSummary={filmSummary} />;
}
