// 图标白名单：工具只能引用这里定义的图标标识（PRD §6.2）。
// 此文件必须保持自包含（无任何 import），供门户组件与配置校验脚本共同使用。
export const ICONS: Record<string, string> = {
  key: "M15.75 5.5a4.75 4.75 0 1 0-4.5 6.53L4 19.28V21h2.72l1.14-1.14v-1.72h1.72l1.14-1.14v-1.72h1.72l1.36-1.36a4.75 4.75 0 0 0 2.95-7.42Zm-1.9 2.85a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z",
  chart: "M4 20h16v2H2V2h2v18Zm3-3V9h3v8H7Zm5 0V4h3v13h-3Zm5 0v-6h3v6h-3Z",
  image: "M21 3H3v18h18V3ZM5 5h14v9.59l-3.3-3.3-4.2 4.2-2.5-2.5L5 17.09V5Zm3.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  box: "M12 1 3 5.5v13L12 23l9-4.5v-13L12 1Zm0 2.24 6.5 3.25L12 9.74 5.5 6.49 12 3.24ZM5 8.24l6 3v9.02l-6-3V8.24Zm8 12.02v-9.02l6-3v9.02l-6 3Z",
  qrcode: "M3 3h8v8H3V3Zm2 2v4h4V5H5Zm1 1h2v2H6V6Zm7-3h8v8h-8V3Zm2 2v4h4V5h-4Zm1 1h2v2h-2V6ZM3 13h8v8H3v-8Zm2 2v4h4v-4H5Zm1 1h2v2H6v-2Zm7-3h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4-2h2v2h-2v-2Zm0 4h2v2h2v2h-2v2h-2v-2h2v-2Z",
  map: "M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z",
};

export const ICON_IDS: string[] = Object.keys(ICONS);
export const DEFAULT_ICON = "box";
