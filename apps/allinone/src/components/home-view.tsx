"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ToolIcon } from "@/components/tool-icon";
import { matchesQuery } from "@/lib/search";
import { pushRecent, readFavorites, readRecent, toggleFavorite } from "@/lib/storage";
import type { CategoryConfig, ToolConfig, ToolStatus } from "@/lib/types";

interface HomeViewProps {
  tools: ToolConfig[];
  categories: CategoryConfig[];
  loadError: string | null;
  documentSummary?: { total: number; expiring: number; expired: number } | null;
  documentReminderError?: boolean;
}

const STATE_LABEL: Record<ToolStatus["state"], string> = {
  ok: "可访问",
  unreachable: "暂不可用",
  unknown: "未知",
  unmonitored: "未监测",
};

const STATE_CLASS: Record<ToolStatus["state"], string> = {
  ok: "ok",
  unreachable: "unreachable",
  unknown: "unknown",
  unmonitored: "unmonitored",
};

function statusLine(state: ToolStatus["state"], checkedAt: string | null): string {
  const label = STATE_LABEL[state];
  if (state === "ok" || state === "unreachable") {
    if (!checkedAt) return label;
    const time = new Date(checkedAt);
    return `${label} · ${isNaN(time.getTime()) ? "" : time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return label;
}

export function HomeView({ tools, categories, loadError, documentSummary, documentReminderError }: HomeViewProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ToolStatus> | null>(null);

  // 首帧挂载后读取本地收藏/最近记录，并异步拉取工具状态。
  // 挂载前不读取 localStorage，避免服务端/客户端渲染不一致。
  useEffect(() => {
    setFavorites(readFavorites());
    setRecent(readRecent());
    let cancelled = false;
    fetch("/api/tools/status", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ tools: ToolStatus[] }>) : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.tools)) {
          setStatuses(Object.fromEntries(data.tools.map((s) => [s.id, s])));
        }
      })
      .catch(() => {
        if (!cancelled) setStatuses((prev) => prev ?? {});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const searching = query.trim().length > 0;
  const filtered = tools.filter((tool) => {
    if (category !== "all" && tool.category !== category) return false;
    return matchesQuery(
      {
        name: tool.name,
        description: tool.description,
        tags: tool.tags ?? [],
        aliases: tool.aliases ?? [],
      },
      query,
    );
  });

  const favoriteTools = tools.filter((t) => favorites.includes(t.id));
  const recentTools = recent
    .map((id) => tools.find((t) => t.id === id))
    .filter((t): t is ToolConfig => Boolean(t));

  const onOpen = (id: string) => {
    pushRecent(id);
    setRecent(readRecent());
  };

  const onToggleFavorite = (id: string) => {
    toggleFavorite(id);
    setFavorites(readFavorites());
  };

  return (
    <div>
      <h1 className="page-title">我的工具箱</h1>
      <p className="page-sub">业务管理、金融监控与图片创作工具的统一入口。</p>

      {loadError ? <div className="error-banner">工具配置加载失败：{loadError}</div> : null}
      {documentReminderError ? <p role="status" className="error-banner">证件到期提示暂时无法读取，请打开证件夹检查。</p> : null}
      {documentSummary && (documentSummary.expiring > 0 || documentSummary.expired > 0) ? (
        <section className="document-reminder" aria-label="证件到期提示">
          <div><strong>证件有效期提醒</strong><span>提前 30 天提醒，按北京时间更新</span></div>
          <div className="document-reminder-links">
            {documentSummary.expiring > 0 ? <Link href="/documents?status=expiring">{documentSummary.expiring} 份即将到期 →</Link> : null}
            {documentSummary.expired > 0 ? <Link href="/documents?status=expired" className="document-reminder-expired">{documentSummary.expired} 份已过期 →</Link> : null}
          </div>
        </section>
      ) : null}

      <label className="sr-only" htmlFor="tool-search" style={{ position: "absolute", left: -9999 }}>
        搜索工具
      </label>
      <input
        id="tool-search"
        className="search-input"
        type="search"
        placeholder="搜索工具名称、用途或标签"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />

      <div className="category-row" role="group" aria-label="分类筛选">
        <button
          type="button"
          className="category-chip"
          aria-pressed={category === "all"}
          onClick={() => setCategory("all")}
        >
          全部
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className="category-chip"
            aria-pressed={category === cat.id}
            title={cat.description}
            onClick={() => setCategory(cat.id)}
          >
            {cat.name}
          </button>
        ))}
      </div>

      {!searching && favoriteTools.length > 0 ? (
        <section aria-label="收藏">
          <h2 className="section-title">收藏</h2>
          <div className="tool-grid">
            {favoriteTools.map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                documentSummary={documentSummary}
                categories={categories}
                status={statuses?.[tool.id]}
                favorite={favorites.includes(tool.id)}
                onOpen={onOpen}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </div>
        </section>
      ) : null}

      {!searching && recentTools.length > 0 ? (
        <section aria-label="最近打开">
          <h2 className="section-title">最近打开</h2>
          <div className="tool-grid">
            {recentTools.map((tool) => (
              <ToolCard
                key={`recent-${tool.id}`}
                tool={tool}
                documentSummary={documentSummary}
                categories={categories}
                status={statuses?.[tool.id]}
                favorite={favorites.includes(tool.id)}
                onOpen={onOpen}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-label="全部工具">
        <h2 className="section-title">{searching ? "搜索结果" : "全部工具"}</h2>
        {filtered.length === 0 ? (
          <div className="empty-note">
            没有找到匹配的工具。
            <button
              type="button"
              className="category-chip"
              style={{ marginLeft: 8 }}
              onClick={() => {
                setQuery("");
                setCategory("all");
              }}
            >
              清空筛选
            </button>
          </div>
        ) : (
          <div className="tool-grid">
            {filtered.map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                documentSummary={documentSummary}
                categories={categories}
                status={statuses?.[tool.id]}
                favorite={favorites.includes(tool.id)}
                onOpen={onOpen}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface ToolCardProps {
  tool: ToolConfig;
  categories: CategoryConfig[];
  status?: ToolStatus;
  favorite: boolean;
  onOpen: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}

function ToolCard({ tool, categories, status, favorite, onOpen, onToggleFavorite, documentSummary }: ToolCardProps & { documentSummary?: { total: number; expiring: number; expired: number } | null }) {
  const categoryName = categories.find((c) => c.id === tool.category)?.name ?? tool.category;
  const external = tool.openMode === "new-tab";
  const documentBadge = tool.id === "documents" && documentSummary && (documentSummary.expiring > 0 || documentSummary.expired > 0)
    ? documentSummary
    : null;

  return (
    <article className="tool-card">
      <div className="tool-card-top">
        <ToolIcon icon={tool.icon} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="tool-name-row">
            <Link href={`/tools/${tool.id}`} className="tool-name" title={tool.name}>
              {tool.name}
            </Link>
            {documentBadge ? (
              <Link href="/documents" className="tag-badge document-badge" aria-label={`${documentBadge.expiring + documentBadge.expired} 份证件需要处理`}>
                {documentBadge.expiring + documentBadge.expired} 份需处理
              </Link>
            ) : null}
            {tool.integration === "external" ? <span className="tag-badge">外部</span> : null}
          </div>
          <p className="tool-desc">{tool.description}</p>
        </div>
        <button
          type="button"
          className="fav-button"
          aria-pressed={favorite}
          aria-label={favorite ? `取消收藏 ${tool.name}` : `收藏 ${tool.name}`}
          title={favorite ? "取消收藏" : "收藏"}
          onClick={() => onToggleFavorite(tool.id)}
        >
          {favorite ? "★" : "☆"}
        </button>
      </div>
      <div className="tool-card-bottom">
        <div className="tool-meta">
          {status ? (
            <span title={statusLine(status.state, status.checkedAt)}>
              <span className={`status-dot ${STATE_CLASS[status.state]}`} aria-hidden="true" />
              {STATE_LABEL[status.state]}
            </span>
          ) : null}
          <span className="tag-badge">{categoryName}</span>
        </div>
        <OpenButton tool={tool} onOpen={onOpen} />
      </div>
    </article>
  );
}

export function OpenButton({ tool, onOpen }: { tool: ToolConfig; onOpen?: (id: string) => void }) {
  const external = tool.openMode === "new-tab";
  return (
    <a
      className="open-button"
      href={tool.entry}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      onClick={() => onOpen?.(tool.id)}
    >
      打开{external ? " ↗" : ""}
    </a>
  );
}
