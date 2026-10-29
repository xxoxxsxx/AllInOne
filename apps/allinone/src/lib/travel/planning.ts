// Shared pure helpers: browser preview and server validation use the same rules.
export const MAX_BATCH_PLACES = 50;
export const MAX_PLACE_NAME_LENGTH = 80;
export const MAX_BATCH_TEXT_LENGTH = 12_000;

/** Zero-based day index. Invalid or missing date/index returns an empty label. */
export function dayDateLabel(startDate: string, index: number): string {
  if (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !Number.isSafeInteger(index) || index < 0) return "";
  const date = new Date(`${startDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== startDate) return "";
  date.setUTCDate(date.getUTCDate() + index);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) return "";
  // Always include the year so a trip spanning New Year is unambiguous.
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][date.getUTCDay()];
  return `${String(date.getUTCFullYear()).padStart(4, "0")}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 · 星期${weekday}`;
}

/** Blank lines are ignored; duplicate place names remain separate stops. */
export function parsePlaceLines(rawText: string): string[] {
  if (typeof rawText !== "string") throw new Error("请粘贴地点名称文本");
  if (rawText.length > MAX_BATCH_TEXT_LENGTH) throw new Error(`粘贴文本最多 ${MAX_BATCH_TEXT_LENGTH} 个字符`);
  const names = rawText.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
  if (names.length > MAX_BATCH_PLACES) throw new Error(`每批最多添加 ${MAX_BATCH_PLACES} 个地点`);
  names.forEach((name, index) => {
    if (name.length > MAX_PLACE_NAME_LENGTH) throw new Error(`第 ${index + 1} 个地点名称最多 ${MAX_PLACE_NAME_LENGTH} 个字符`);
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`第 ${index + 1} 个地点名称包含无效控制字符`);
  });
  return names;
}
