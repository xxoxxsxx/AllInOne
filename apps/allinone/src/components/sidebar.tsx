"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ToolIcon } from "@/components/tool-icon";
import { matchesQuery } from "@/lib/search";
import { pushRecent, readFavorites, readRecent, toggleFavorite } from "@/lib/storage";
import { toolHref } from "@/lib/tool-entry";
import type { CategoryConfig, ToolConfig } from "@/lib/types";

const siteLinks = [
  { href: "/", label: "工作台概览" },
  { href: "/status", label: "服务状态" },
  { href: "/preferences", label: "显示偏好" },
  { href: "/channels", label: "推送渠道" },
];

export function Sidebar({ tools, categories }: { tools: ToolConfig[]; categories: CategoryConfig[] }) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const sync = () => {
      setFavorites(readFavorites());
      setRecent(readRecent());
    };
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("portal-preferences", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("portal-preferences", sync);
    };
  }, []);

  const searching = Boolean(query.trim());
  const filtered = tools.filter((tool) => matchesQuery({
    name: tool.name,
    description: tool.description,
    tags: tool.tags ?? [],
    aliases: tool.aliases ?? [],
  }, query));
  const knownCategories = new Set(categories.map((category) => category.id));
  const groups = categories.map((category) => ({
    ...category,
    tools: filtered.filter((tool) => tool.category === category.id),
  }));
  const uncategorized = filtered.filter((tool) => !knownCategories.has(tool.category));
  const activeTool = tools.find((tool) => {
    const entry = tool.entry.replace(/\/+$/, "");
    return pathname === "/tools/" + tool.id || (entry && (pathname === entry || pathname.startsWith(entry + "/")));
  });

  function closeMenu() {
    if (menuButton.current?.getClientRects().length) menuButton.current.focus();
    setExpanded(false);
    setQuery("");
  }

  function toolLink(tool: ToolConfig) {
    const href = toolHref(tool);
    const newTab = tool.openMode === "new-tab" && tool.lifecycle !== "maintenance";
    const active = tool.id === activeTool?.id;
    const onClick = () => {
      closeMenu();
      if (tool.lifecycle !== "maintenance") pushRecent(tool.id);
    };
    const label = <><ToolIcon icon={tool.icon} /><span>{tool.name}</span>{newTab && <span aria-label="新标签页">↗</span>}</>;
    const props = { className: "portal-link", title: tool.description, onClick, "aria-current": active ? "page" as const : undefined };
    return newTab || (tool.integration !== "path" && tool.lifecycle !== "maintenance")
      ? <a href={href} {...props} target={newTab ? "_blank" : undefined} rel={newTab ? "noopener noreferrer" : undefined}>{label}</a>
      : <Link href={href} {...props} prefetch={false}>{label}</Link>;
  }

  function shortcuts(ids: string[], title: string) {
    const items = ids.map((id) => tools.find((tool) => tool.id === id)).filter((tool) => tool !== undefined);
    return items.length > 0 && (
      <details className="portal-shortcuts">
        <summary>{title}</summary>
        <ul>{items.map((tool) => <li key={tool.id}>{toolLink(tool)}</li>)}</ul>
      </details>
    );
  }

  return (
    <aside className="portal-sidebar" onKeyDown={(event) => {
      if (event.key === "Escape" && expanded) closeMenu();
    }}>
      <div className="portal-brand-row">
        <Link href="/" className="portal-brand" onClick={closeMenu}>
          <span aria-hidden="true">▦</span> 我的工具箱
        </Link>
        <button ref={menuButton} type="button" className="portal-menu-button" aria-expanded={expanded}
          aria-controls="portal-menu" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起菜单" : "工具菜单"}
        </button>
      </div>
      <nav id="portal-menu" aria-label="工具箱导航" className="portal-menu" data-expanded={expanded}>
        {!searching && <Link href="/" className="portal-link" onClick={closeMenu}
          aria-current={pathname === "/" ? "page" : undefined}>{siteLinks[0].label}</Link>}
        <input type="search" className="portal-search" aria-label="搜索工具" placeholder="搜索工具…"
          value={query} onChange={(event) => setQuery(event.target.value)} />
        {!searching && shortcuts(favorites, "收藏")}
        {!searching && shortcuts(recent, "最近打开")}
        {filtered.length === 0 && <p className="portal-empty" role="status">{searching ? "没有匹配的工具" : "暂无可用工具"}</p>}
        {[...groups, { id: "other", name: "其他工具", tools: uncategorized }].filter((group) => group.tools.length).map((group) => (
          <section key={group.id} aria-label={group.name} className="portal-group">
            <h2>{group.name}</h2>
            <ul>{group.tools.map((tool) => (
              <li className="portal-tool" key={tool.id}>
                {toolLink(tool)}
                <button type="button" className="portal-favorite" aria-pressed={favorites.includes(tool.id)}
                  aria-label={(favorites.includes(tool.id) ? "取消收藏 " : "收藏 ") + tool.name}
                  onClick={() => toggleFavorite(tool.id)}>{favorites.includes(tool.id) ? "★" : "☆"}</button>
              </li>
            ))}</ul>
          </section>
        ))}
        {!searching && (
          <section className="portal-group" aria-label="系统设置">
            <h2>系统设置</h2>
            <ul>{siteLinks.slice(1).map(({ href, label }) => (
              <li key={href}><Link className="portal-link" href={href} onClick={closeMenu}
                aria-current={pathname === href ? "page" : undefined}>{label}</Link></li>
            ))}</ul>
          </section>
        )}
      </nav>
    </aside>
  );
}
