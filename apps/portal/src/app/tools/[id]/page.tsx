import Link from "next/link";
import { notFound } from "next/navigation";
import { OpenButton, STATUS_LABEL } from "@/components/tool-actions";
import { ToolIcon } from "@/components/tool-icon";
import { getStatuses } from "@/lib/health";
import { loadCatalog } from "@/lib/tools";

export const dynamic = "force-dynamic";

interface ToolDetailProps {
  params: Promise<{ id: string }>;
}

export default async function ToolDetailPage({ params }: ToolDetailProps) {
  const { id } = await params;
  const { tools, categories } = loadCatalog();
  const tool = tools.find((t) => t.id === id);
  if (!tool) notFound();

  const categoryName = categories.find((c) => c.id === tool.category)?.name ?? tool.category;
  // 维护中的工具默认禁止打开（PRD §5.6）。
  const openable = tool.lifecycle !== "maintenance";

  let statusState: "ok" | "unreachable" | "unknown" | "unmonitored" = "unmonitored";
  let checkedAt: string | null = null;
  if (tool.integration !== "external") {
    try {
      const statuses = await getStatuses();
      const found = statuses.find((s) => s.id === tool.id);
      if (found) {
        statusState = found.state;
        checkedAt = found.checkedAt;
      }
    } catch {
      statusState = "unknown";
    }
  }

  const detailRows: Array<[string, string]> = [
    ["分类", categoryName],
    ["类型", KIND_LABEL[tool.kind]],
    ...(tool.tags && tool.tags.length > 0 ? ([["标签", tool.tags.join("、")]] as Array<[string, string]>) : []),
    ...(tool.aliases && tool.aliases.length > 0 ? ([["别名", tool.aliases.join("、")]] as Array<[string, string]>) : []),
    ...(tool.integration !== "external"
      ? ([["状态", `${STATUS_LABEL[statusState]}${checkedAt ? ` · ${formatTime(checkedAt)}` : ""}`]] as Array<[string, string]>)
      : []),
  ];

  return (
    <div>
      <Link href="/" className="back-link">
        ← 返回工具箱
      </Link>
      <div className="detail-card">
        <div className="detail-head">
          <ToolIcon icon={tool.icon} />
          <h1 className="detail-title">{tool.name}</h1>
        </div>
        <p className="detail-desc">{tool.description}</p>

        {tool.lifecycle === "maintenance" ? (
          <div className="maintenance-note" role="status">
            {tool.maintenanceMessage ?? "该工具正在维护中，暂时无法打开。"}
          </div>
        ) : null}

        <dl className="detail-rows">
          {detailRows.map(([label, value]) => (
            <div className="detail-row" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        {openable ? <OpenButton tool={tool} /> : null}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  static: "静态页面",
  service: "独立服务",
  external: "外部链接",
};

function formatTime(iso: string): string {
  const time = new Date(iso);
  return isNaN(time.getTime()) ? "" : time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
