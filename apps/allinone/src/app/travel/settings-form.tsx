"use client";

// 高德 Web 服务 Key 设置：仅服务器保存完整 Key，客户端只见「已配置」状态。
// 保存替换 / 单独删除（带确认）；输入不回显已存 Key，autocomplete 关闭避免浏览器缓存泄露。

import { useId, useRef, useState } from "react";
import { saveAmapSettingsAction } from "./settings-actions";

function maskError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function AmapSettingsForm({ configured }: { configured: boolean }) {
  const id = useId();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<"save" | "clear" | null>(null);
  const lock = useRef(false);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (lock.current) return;
    const value = key.trim();
    if (!/^[0-9a-fA-F]{32}$/.test(value)) {
      setError("Key 应为高德控制台生成的 32 位字符串（字母或数字）。请复制后粘贴，不要手动输入。");
      return;
    }
    lock.current = true; setPending("save"); setError(""); setNotice("");
    try {
      const result = await saveAmapSettingsAction(value, false);
      if (result.ok) { setKey(""); setNotice("已保存。行程页的搜索框即可使用。"); }
      else setError(result.error || "保存失败，请重试");
    } catch (reason) {
      setError(maskError(reason, "保存请求未完成，请重试"));
    } finally {
      lock.current = false; setPending(null);
    }
  };

  const clear = async () => {
    if (lock.current) return;
    if (!window.confirm("确定删除已配置的高德 Key？行程页的地点搜索将停用（已创建的地点不受影响）。")) return;
    lock.current = true; setPending("clear"); setError(""); setNotice("");
    try {
      const result = await saveAmapSettingsAction("", true);
      if (result.ok) setNotice("已删除。需要搜索时可随时重新配置。");
      else setError(result.error || "删除失败，请重试");
    } catch (reason) {
      setError(maskError(reason, "删除请求未完成，请重试"));
    } finally {
      lock.current = false; setPending(null);
    }
  };

  return <form className="travel-settings-form" onSubmit={save} aria-busy={pending !== null}>
    <label htmlFor={`${id}-key`}>高德 Web 服务 Key {configured ? "（已配置）" : "（未配置）"}
      <input
        id={`${id}-key`}
        type="password"
        inputMode="text"
        autoComplete="off"
        // 已配置时不回显任何 Key 内容；占位符只提示状态。
        placeholder={configured ? "••••••••••••（已安全保存，输入新 Key 可替换）" : "粘贴 32 位 Key"}
        value={key}
        maxLength={64}
        disabled={pending !== null}
        onChange={event => { setKey(event.target.value); setError(""); setNotice(""); }}
      />
    </label>
    <p className="travel-settings-hint">
      申请方式：高德开放平台 → 控制台 → 应用管理 → 创建新应用 → 添加 Key，服务平台选择「
      <strong>Web 服务</strong>」。个人实名认证即可，无需营业执照；免费额度按高德账号政策执行。
      {" "}<a href="https://console.amap.com/dev/key/app" target="_blank" rel="noreferrer noopener">前往高德控制台申请 ↗</a>
    </p>
    {error && <p className="travel-settings-error" role="alert">{error}</p>}
    {notice && <p className="travel-settings-notice" role="status">{notice}</p>}
    <div className="travel-settings-actions">
      <button type="submit" disabled={pending !== null || !key.trim()}>
        {pending === "save" ? "保存中…" : configured ? "替换 Key" : "保存 Key"}
      </button>
      {configured && <button type="button" className="travel-settings-danger" disabled={pending !== null} onClick={clear}>
        {pending === "clear" ? "删除中…" : "删除已配置的 Key"}
      </button>}
    </div>
    <p className="travel-settings-footnote">Key 保存在 NAS 本地数据库，不会出现在页面或导出文件中；搜索用量与费用由你的高德账号承担。</p>
  </form>;
}
