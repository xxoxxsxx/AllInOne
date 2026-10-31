"use client";

// 证件夹表单的移动端标签选择器：已选芯片 + 单行输入 + 既有标签联想（无需 portal）。
// 服务端限制见 src/lib/documents/db.ts 的 upsertTags：每份证件最多 20 个标签、
// 单个标签 ≤ 40 字符（服务端还会 trim 与精确去重）。客户端拒绝时不做任何静默截断。
//
// 录入分隔规则（有意从简，避免空格切分歧义）：
// - 只有 回车 / 半角逗号 / 全角逗号 / 顿号 / 半角分号 / 全角分号 会把输入提交并切分；
//   （顿号、全角分号属于逗号家族：旧表单即以「、」拼接展示标签，中文输入法最常用。）
// - 空格【不】切分：这样「北京 常用」「travel docs」这类含空格的中文/词组标签
//   可以经回车（或联想点击）整段录入，不会被拆成碎片段；
// - 去重按去首尾空格后的大小写不敏感比较（比服务端的精确比较更严格）；
// - 重复 / 超 20 个 / 超 40 字符 均以内联提示拒绝。
//
// 注意：PURE-HELPERS BEGIN/END 标记之间的区块必须保持「无 import、无 JSX」——
// tests/documents-tag-picker.test.ts 会原样截取该区块写入临时 .ts 由 node 加载测试。

import "./tag-picker.css";

import { useId, useRef, useState, type FocusEvent } from "react";

// >>> PURE-HELPERS BEGIN

// 与服务端 upsertTags（src/lib/documents/db.ts）保持一致的硬限制。
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
// 联想列表最多展示的既有标签数。
export const MAX_SUGGESTIONS = 8;

export type TagOption = { id: number; name: string };

export type AddTagsResult =
  | { ok: true; tags: string[] }
  | { ok: false; error: string };

// 分隔符：半角逗号、全角逗号、顿号、半角分号、全角分号。空格不是分隔符（见文件头规则）。
const TAG_SEPARATOR_RE = /[,，、;；]/;

export function containsTagSeparator(raw: string): boolean {
  return TAG_SEPARATOR_RE.test(raw);
}

// 把输入文本按分隔符切分成候选标签：去首尾空格、丢弃空段。回车不在此处理——
// 组件在 Enter 键与「输入中出现分隔符」两条路径上都调用 addTagsFromInput，
// 由它统一完成「切分 + 校验」，保证回车与逗号行为完全一致。
function splitTagInput(raw: string): string[] {
  return raw
    .split(TAG_SEPARATOR_RE)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 尝试把 raw 输入解析出的标签追加到 current：
 * - 无有效候选 → 原样返回 current（同一引用，组件据此跳过 onChange）；
 * - 与已有标签或批内互相重复（大小写不敏感）→ 拒绝并给出内联提示；
 * - 超出 20 个 / 单个超 40 字符（与服务端一致的校验顺序：先数量后长度）→ 拒绝；
 * - 通过 → 返回追加后的新数组。
 */
export function addTagsFromInput(current: string[], raw: string): AddTagsResult {
  const candidates = splitTagInput(raw);
  if (candidates.length === 0) return { ok: true, tags: current };
  // 批内去重：大小写不敏感（对中文无影响），保留首次出现的写法。
  const unique: string[] = [];
  for (const name of candidates) {
    if (!unique.some((t) => t.toLowerCase() === name.toLowerCase())) unique.push(name);
  }
  for (const name of unique) {
    if (current.some((t) => t.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: `标签「${name}」已存在` };
    }
  }
  if (current.length + unique.length > MAX_TAGS) {
    return { ok: false, error: `每份证件最多 ${MAX_TAGS} 个标签（当前已选 ${current.length} 个）` };
  }
  for (const name of unique) {
    // 按 JS 字符数计（中文记 1，与服务端一致）；按去首尾空格后的长度校验。
    if (name.length > MAX_TAG_LENGTH) {
      return { ok: false, error: `单个标签最多 ${MAX_TAG_LENGTH} 个字符` };
    }
  }
  return { ok: true, tags: [...current, ...unique] };
}

/**
 * 既有标签联想：排除已选（大小写不敏感），输入非空时按子串过滤，
 * 最多返回 limit（默认 8）条；输入为空时返回排在前面的既有标签，方便移动端点选。
 */
export function filterTagSuggestions(options: TagOption[], input: string, selected: string[], limit: number = MAX_SUGGESTIONS): TagOption[] {
  const query = input.trim().toLowerCase();
  const chosen = new Set(selected.map((t) => t.toLowerCase()));
  const matches: TagOption[] = [];
  for (const opt of options) {
    if (chosen.has(opt.name.toLowerCase())) continue;
    if (query !== "" && !opt.name.toLowerCase().includes(query)) continue;
    matches.push(opt);
    if (matches.length >= limit) break;
  }
  return matches;
}

// >>> PURE-HELPERS END

export function TagPicker(props: {
  value: string[];
  options: Array<{ id: number; name: string }>;
  onChange: (tags: string[]) => void;
  ariaLabel?: string;
}) {
  const { value, options, onChange, ariaLabel = "添加标签" } = props;
  const [input, setInput] = useState("");
  const [hint, setHint] = useState("");
  const [open, setOpen] = useState(false);
  const inputId = useId();
  const listId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const suggestions = filterTagSuggestions(options, input, value);

  // 回车 / 逗号 / 粘贴共用的提交入口：成功则清空输入，失败则保留输入并显示内联提示。
  function commit(raw: string): void {
    const res = addTagsFromInput(value, raw);
    if (!res.ok) {
      setHint(res.error);
      return;
    }
    setHint("");
    setInput("");
    // 空候选时返回的是原引用，跳过 onChange，避免父组件无谓重渲染。
    if (res.tags !== value) onChange(res.tags);
  }

  function removeAt(index: number): void {
    setHint("");
    onChange(value.filter((_, i) => i !== index));
  }

  // 输入内容变化：若出现分隔符（虚拟键盘 / 粘贴，未必触发 keydown）直接切分提交。
  function onInputChange(next: string): void {
    setInput(next);
    if (containsTagSeparator(next)) commit(next);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    // 中文输入法组词中的回车用于确认候选词，不提交标签。
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      // 阻止冒泡提交外层表单（本选择器位于证件表单内）。
      e.preventDefault();
      commit(input);
      return;
    }
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    if (e.key === "Backspace" && input === "" && value.length > 0) {
      e.preventDefault();
      removeAt(value.length - 1);
    }
  }

  // React 的 onFocus/onBlur 按 focusin/focusout 冒泡：焦点仍在容器内（如移到联想按钮）不收起。
  function onFocusOut(e: FocusEvent<HTMLDivElement>): void {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setOpen(false);
  }

  return (
    <div className="tag-picker" onFocus={() => setOpen(true)} onBlur={onFocusOut}>
      <div
        className="tag-picker-row"
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {value.length > 0 ? (
          <ul className="tag-picker-chips" role="list" aria-label="已选标签">
            {value.map((tag, i) => (
              <li key={`${tag}-${i}`} role="listitem" className="tag-picker-chip">
                <span className="tag-picker-chip-name">{tag}</span>
                <button
                  type="button"
                  className="tag-picker-chip-remove"
                  aria-label={`移除标签 ${tag}`}
                  onClick={() => removeAt(i)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          id={inputId}
          ref={inputRef}
          className="tag-picker-input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onInputKeyDown}
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={hintId}
          aria-label={ariaLabel}
          placeholder="输入后回车或逗号添加；支持粘贴逗号分隔"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      {open && suggestions.length > 0 ? (
        <div ref={listRef} id={listId} className="tag-picker-suggestions" role="listbox" aria-label="已有标签建议">
          {suggestions.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={false}
              className="tag-picker-suggestion"
              aria-label={`点击添加「${t.name}」`}
              // 按下时不让 input 失焦，否则容器 onBlur 会先收起列表导致点击落空。
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(t.name)}
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : null}
      {/* 校验提示：role=status 让屏幕阅读器即时播报拒绝原因。 */}
      <p id={hintId} className="tag-picker-hint" role="status">
        {hint}
      </p>
    </div>
  );
}
