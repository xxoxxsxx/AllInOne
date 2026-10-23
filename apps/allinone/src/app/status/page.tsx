import { STATUS_LABEL } from "@/components/tool-actions";
import { getStatuses } from "@/lib/health";
import { loadCatalog } from "@/lib/tools";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "工具状态 · 我的工具箱",
};

function formatTime(iso: string | null): string {
  if (!iso) return "尚未检查";
  const time = new Date(iso);
  return isNaN(time.getTime()) ? "尚未检查" : time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default async function StatusPage() {
  const { tools } = loadCatalog();
  let statuses: Awaited<ReturnType<typeof getStatuses>> = [];
  try {
    statuses = await getStatuses();
  } catch {
    statuses = [];
  }
  const byId = new Map(statuses.map((s) => [s.id, s]));

  return (
    <div>
      <h1 className="page-title">工具状态</h1>
      <p className="page-sub">状态来自服务端定期检查，“可访问”仅表示检查目标通过，不代表业务功能或通知链路正常。</p>
      <div className="status-list">
        {tools.map((tool) => {
          const status = byId.get(tool.id);
          const state = tool.integration === "external" ? "unmonitored" : (status?.state ?? "unknown");
          const checkedAt = status?.checkedAt ?? null;
          return (
            <div className="status-item" key={tool.id}>
              <div>
                <div className="status-item-name">
                  <span className={`status-dot ${state}`} aria-hidden="true" />
                  {tool.name}
                  {tool.lifecycle === "maintenance" ? <span className="tag-badge" style={{ marginLeft: 8 }}>维护中</span> : null}
                </div>
                <div className="status-item-detail">
                  {tool.lifecycle === "maintenance"
                    ? (tool.maintenanceMessage ?? "该工具正在维护中。")
                    : `${STATUS_LABEL[state]} · 检查于 ${formatTime(checkedAt)}`}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
