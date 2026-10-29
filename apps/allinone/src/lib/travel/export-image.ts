import type { Trip } from "./db";
import { dayDateLabel } from "./planning";
import { gcj02ToWgs84 } from "./coordinates";

export const EXPORT_WIDTH = 1080;
export const EXPORT_MAX_HEIGHT = 12000;
export const EXPORT_MAX_PAGES = 12;
const PAD = 56;
const CONTENT = EXPORT_WIDTH - PAD * 2;
export type TextBlock = { kind: "text"; text: string; size: number; color: string; height: number };
export type PhotoBlock = { kind: "photos"; files: string[]; height: number };
export type MapPoint = { label: string; lat: number; lng: number; group: number };
export type MapBlock = { kind: "map"; points: MapPoint[]; height: number };
export type ExportBlock = TextBlock | PhotoBlock | MapBlock;
export type ExportPage = { blocks: ExportBlock[]; height: number };

/** Wrap by Unicode code point, preserving explicit newlines and every character. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  if (!(maxWidth > 0)) throw new Error("文字布局宽度无效");
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const char of Array.from(paragraph)) {
      if (line && measure(line + char) > maxWidth) { lines.push(line); line = ""; }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}

/** Blocks are already split into individual text lines; no block can be clipped. */
export function paginateBlocks(blocks: ExportBlock[], maxHeight = EXPORT_MAX_HEIGHT, maxPages = EXPORT_MAX_PAGES): ExportPage[] {
  const usable = maxHeight - PAD * 2 - 48;
  if (usable <= 0 || maxPages < 1) throw new Error("分页参数无效");
  const pages: ExportPage[] = [];
  let current: ExportBlock[] = [], height = 0;
  const flush = () => {
    if (!current.length) return;
    if (pages.length >= maxPages) throw new Error(`行程过长，最多导出 ${maxPages} 张长图，请减少内容后重试`);
    pages.push({ blocks: current, height: Math.ceil(height + PAD * 2 + 48) }); current = []; height = 0;
  };
  for (const block of blocks) {
    if (!Number.isFinite(block.height) || block.height <= 0 || block.height > usable) throw new Error("内容块超出单页高度");
    if (height + block.height > usable) flush();
    current.push(block); height += block.height;
  }
  flush();
  return pages;
}

/** Mercator projection with longitude unwrapping for routes crossing the date line. */
export function projectPoints(points: MapPoint[], width: number, height: number): Array<MapPoint & { x: number; y: number }> {
  if (!points.length) return [];
  const base = points[0].lng;
  const raw = points.map(p => {
    const lng = base + ((((p.lng - base) + 180) % 360 + 360) % 360 - 180);
    const lat = Math.max(-85, Math.min(85, p.lat)) * Math.PI / 180;
    return { ...p, x: lng * Math.PI / 180, y: -Math.log(Math.tan(Math.PI / 4 + lat / 2)) };
  });
  const minX = Math.min(...raw.map(p => p.x)), maxX = Math.max(...raw.map(p => p.x));
  const minY = Math.min(...raw.map(p => p.y)), maxY = Math.max(...raw.map(p => p.y));
  const scale = Math.min((width - 80) / Math.max(maxX - minX, 0.000001), (height - 80) / Math.max(maxY - minY, 0.000001));
  return raw.map(p => ({ ...p, x: width / 2 + (p.x - (minX + maxX) / 2) * scale, y: height / 2 + (p.y - (minY + maxY) / 2) * scale }));
}

export function layoutTrip(trip: Trip, measure: (text: string, size: number) => number): ExportPage[] {
  const blocks: ExportBlock[] = [];
  const text = (value: string, size = 28, color = "#334155") => {
    for (const line of wrapText(value, CONTENT, s => measure(s, size))) blocks.push({ kind: "text", text: line, size, color, height: Math.ceil(size * 1.55) });
  };
  const gap = () => text("", 20);
  text(trip.title, 48, "#0f172a");
  if (trip.description) text(trip.description, 30);
  text(trip.startDate ? `出发日期：${trip.startDate}` : "出发日期：未设置", 26);
  let seq = 0;
  const groups = [...trip.days.map((day, i) => ({ title: `${day.title}  ${dayDateLabel(trip.startDate, i)}`.trim(), places: day.places })), { title: "待安排", places: trip.loose }];
  const numbered = groups.map((g, group) => ({ ...g, places: g.places.map(p => ({ ...p, label: String(++seq), group })) }));
  const all = numbered.flatMap(g => g.places);
  if (all.length > 1000) throw new Error("地点超过 1000 个，请拆分行程后导出");
  const points: MapPoint[] = all.filter(p => p.lat !== null && p.lng !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng)).map(p => ({ ...gcj02ToWgs84({ lat: p.lat!, lng: p.lng! }), label: p.label, group: p.group }));
  gap(); text("地点分布示意 · 非道路路线", 30, "#0f766e");
  text(`已标注 ${points.length} 个地点 · 未标注 ${all.length - points.length} 个地点`, 24);
  if (points.length) blocks.push({ kind: "map", points, height: 500 });
  else text("暂无坐标，以下保留完整行程内容。", 26);
  numbered.forEach((g, i) => {
    if (i === numbered.length - 1 && !g.places.length) return;
    gap(); text(g.title, 36, "#0f766e");
    if (!g.places.length) text("这一天暂无地点", 26);
    for (const p of g.places) {
      gap(); text(`${p.label}. ${p.name}`, 34, "#0f172a");
      if (p.timeLabel) text(`时间：${p.timeLabel}`);
      if (p.cost) text(`花费：¥${p.cost}`);
      if (p.address) text(`地址：${p.address}`);
      if (p.note) text(`备注：${p.note}`);
      for (const link of p.links) { text(`攻略：${link.title || "参考链接"}`, 26, "#0f766e"); text(link.url, 24); }
      if (p.photos.length) blocks.push({ kind: "photos", files: p.photos.slice(0, 3).map(ph => ph.file), height: 300 });
      if (p.photos.length > 3) text(`另有 ${p.photos.length - 3} 张照片未收录`, 24);
    }
  });
  return paginateBlocks(blocks);
}

export type ExportedImage = { blob: Blob; name: string; width: number; height: number };

/** 用户关闭面板 / 组件卸载触发的取消；调用方按 name 静默处理，不当作失败。 */
export class ExportAbortedError extends Error {
  constructor() {
    super("导出已取消");
    this.name = "ExportAbortedError";
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG 生成失败，可能超出设备内存限制")), "image/png"));
}
async function loadPhoto(file: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api/travel/photos/${encodeURIComponent(file)}`, { signal: controller.signal });
    if (!response.ok) throw new Error("照片读取失败");
    const blob = await response.blob();
    if (blob.size > 8 * 1024 * 1024) throw new Error("照片过大");
    return await createImageBitmap(blob, { resizeWidth: 480, resizeQuality: "high" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Only one page canvas and one decoded photograph are live at a time.
 *  signal 中止后：照片 fetch 立即失败，页面边界快速退出并抛 ExportAbortedError，
 *  不再继续消耗解码与 toBlob 资源（已完成页随异常一并丢弃）。 */
export async function renderTripImages(
  trip: Trip,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ images: ExportedImage[]; warnings: string[] }> {
  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_WIDTH; canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("此浏览器无法生成图片");
  const font = (size: number) => `${size}px system-ui, -apple-system, 'Microsoft YaHei', sans-serif`;
  const pages = layoutTrip(trip, (s, size) => { ctx.font = font(size); return ctx.measureText(s).width; });
  const images: ExportedImage[] = [], warnings: string[] = [];
  let totalBytes = 0;
  try {
    for (let index = 0; index < pages.length; index++) {
      if (signal?.aborted) throw new ExportAbortedError();
      const page = pages[index]; canvas.height = page.height;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.textBaseline = "top";
      let y = PAD;
      for (const block of page.blocks) {
        if (block.kind === "text") {
          ctx.font = font(block.size); ctx.fillStyle = block.color; ctx.fillText(block.text, PAD, y);
        } else if (block.kind === "map") {
          ctx.fillStyle = "#f1f5f9"; ctx.fillRect(PAD, y, CONTENT, block.height - 16);
          const projected = projectPoints(block.points, CONTENT, block.height - 16);
          ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 3; ctx.setLineDash([9, 9]);
          for (let i = 1; i < projected.length; i++) {
            const a = projected[i - 1], b = projected[i];
            if (a.group !== b.group || b.group === trip.days.length) continue;
            ctx.beginPath(); ctx.moveTo(PAD + a.x, y + a.y); ctx.lineTo(PAD + b.x, y + b.y); ctx.stroke();
          }
          ctx.setLineDash([]);
          for (const p of projected) {
            ctx.fillStyle = p.group === trip.days.length ? "#64748b" : "#0f766e";
            ctx.beginPath(); ctx.arc(PAD + p.x, y + p.y, 23, 0, Math.PI * 2); ctx.fill();
            ctx.font = font(21); ctx.fillStyle = "#fff";
            ctx.fillText(p.label, PAD + p.x - ctx.measureText(p.label).width / 2, y + p.y - 13);
          }
        } else {
          const width = (CONTENT - 24 * (block.files.length - 1)) / block.files.length;
          for (let i = 0; i < block.files.length; i++) {
            if (signal?.aborted) throw new ExportAbortedError();
            const x = PAD + i * (width + 24), h = block.height - 18;
            ctx.fillStyle = "#f1f5f9"; ctx.fillRect(x, y, width, h);
            let bitmap: ImageBitmap | undefined;
            try {
              bitmap = await loadPhoto(block.files[i], signal);
              const scale = Math.min(width / bitmap.width, h / bitmap.height);
              ctx.drawImage(bitmap, x + (width - bitmap.width * scale) / 2, y + (h - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
            } catch (e) {
              if (signal?.aborted || e instanceof ExportAbortedError) throw new ExportAbortedError();
              warnings.push(`照片加载失败：${block.files[i]}`);
              ctx.font = font(22); ctx.fillStyle = "#b45309"; ctx.fillText("照片加载失败", x + 14, y + 30);
            } finally { bitmap?.close(); }
          }
        }
        y += block.height;
      }
      ctx.font = font(22); ctx.fillStyle = "#64748b";
      ctx.fillText(`旅行攻略 · 第 ${index + 1} / ${pages.length} 页`, PAD, page.height - PAD);
      const blob = await canvasBlob(canvas);
      totalBytes += blob.size;
      if (totalBytes > 100 * 1024 * 1024) throw new Error("导出图片合计超过 100MB，请拆分行程后重试");
      const safeTitle = trip.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 60) || "旅行攻略";
      images.push({ blob, name: `${safeTitle}-${index + 1}.png`, width: EXPORT_WIDTH, height: page.height });
      canvas.height = 1;
      onProgress(index + 1, pages.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { images, warnings };
  } finally { canvas.width = 1; canvas.height = 1; }
}
