// 工具目录的公共类型定义。仅类型，无运行时代码，可被任意模块安全引用。
export type ToolKind = "static" | "service" | "external";
export type ToolLifecycle = "active" | "maintenance";
export type ToolIntegration = "path" | "host" | "external";
export type OpenMode = "same-tab" | "new-tab";

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  aliases?: string[];
  icon: string;
  kind: ToolKind;
  entry: string;
  openMode: OpenMode;
  order?: number;
  visible: boolean;
  lifecycle: ToolLifecycle;
  maintenanceMessage?: string;
  integration: ToolIntegration;
}

export interface CategoryConfig {
  id: string;
  name: string;
  description?: string;
}

// 健康状态（PRD §7.1）。maintenance 不属于健康检查结果，由 UI 结合工具配置叠加。
export type HealthState = "ok" | "unreachable" | "unknown" | "unmonitored";

export interface ToolStatus {
  id: string;
  state: HealthState;
  checkedAt: string | null;
  reason?: "timeout" | "status" | "network" | "no-entry";
}
