import { HomeView } from "@/components/home-view";
import { loadCatalog } from "@/lib/tools";
import { documentsSummary, getDocumentsDB } from "@/lib/documents/db";
import { getFilmDb, listRolls } from "@/lib/filmlog/store";
import { FundingStore } from "@/lib/funding/store";
import { collectHomeModuleStats } from "@/lib/home-stats";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { tools, error } = loadCatalog();
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
  let fundingPending: number | null = null;
  if (tools.some((tool) => tool.id === "funding")) {
    try {
      const funding = new FundingStore();
      fundingPending = funding.list("batches").filter((batch) => !batch.voided && batch.sourceStatus !== "verified").length
        + funding.list("transfers").filter((transfer) => transfer.status !== "void" && (transfer.pathStatus !== "verified"
          || (transfer.kind === "broker" && transfer.historical && !transfer.allocations.length))).length;
    } catch (error) {
      console.error("入金待核实统计读取失败", error);
    }
  }
  const moduleStats = await collectHomeModuleStats({
    cdkLedger: tools.some((tool) => tool.id === "cdk-ledger"),
    reminders: tools.some((tool) => tool.id === "reminders"),
    stocks: tools.some((tool) => tool.id === "tickersentry"),
  });
  return <HomeView loadError={error} documentSummary={documentSummary} documentReminderError={documentReminderError} filmSummary={filmSummary} fundingPending={fundingPending} stats={moduleStats} />;
}
