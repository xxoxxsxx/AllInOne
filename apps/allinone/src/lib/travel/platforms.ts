// 社交/内容平台链接识别：贴入 URL 自动判断平台并展示对应名称与品牌色。
// 未知域名回落到通用「链接」；不发起网络请求，纯字符串判断。

export type Platform = {
  id: string;
  name: string;
  color: string;
};

const PLATFORMS: Record<string, Platform> = {
  xiaohongshu: { id: "xiaohongshu", name: "小红书", color: "#ff2442" },
  douyin: { id: "douyin", name: "抖音", color: "#161823" },
  bilibili: { id: "bilibili", name: "B站", color: "#fb7299" },
  dianping: { id: "dianping", name: "大众点评", color: "#ff6633" },
  meituan: { id: "meituan", name: "美团", color: "#ffc300" },
  ctrip: { id: "ctrip", name: "携程", color: "#2577e3" },
  qunar: { id: "qunar", name: "去哪儿", color: "#00bcd4" },
  fliggy: { id: "fliggy", name: "飞猪", color: "#ff6a00" },
  weibo: { id: "weibo", name: "微博", color: "#e6162d" },
  wechat: { id: "wechat", name: "微信", color: "#07c160" },
  youtube: { id: "youtube", name: "YouTube", color: "#ff0000" },
  instagram: { id: "instagram", name: "Instagram", color: "#e1306c" },
  tiktok: { id: "tiktok", name: "TikTok", color: "#69c9d0" },
  x: { id: "x", name: "X", color: "#1d9bf0" },
  googlemaps: { id: "googlemaps", name: "Google 地图", color: "#4285f4" },
  amap: { id: "amap", name: "高德地图", color: "#00b96b" },
  baidumap: { id: "baidumap", name: "百度地图", color: "#3385ff" },
  link: { id: "link", name: "链接", color: "#5b6673" },
};

const DOMAINS: Array<[string[], string]> = [
  [["xiaohongshu.com", "xhslink.com"], "xiaohongshu"],
  [["douyin.com", "iesdouyin.com"], "douyin"],
  [["bilibili.com", "b23.tv"], "bilibili"],
  [["dianping.com"], "dianping"], [["meituan.com"], "meituan"],
  [["ctrip.com", "trip.com"], "ctrip"], [["qunar.com"], "qunar"],
  [["fliggy.com"], "fliggy"], [["weibo.cn", "weibo.com"], "weibo"],
  [["weixin.qq.com"], "wechat"], [["youtube.com", "youtu.be"], "youtube"],
  [["instagram.com"], "instagram"], [["tiktok.com"], "tiktok"],
  [["twitter.com", "x.com"], "x"], [["amap.com"], "amap"],
  [["map.baidu.com"], "baidumap"],
];

export function detectPlatform(rawUrl: string): Platform {
  try {
    const text = rawUrl.trim();
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(url.protocol)) return PLATFORMS.link;
    const host = url.hostname.toLowerCase();
    if (host === "maps.app.goo.gl" || (host === "goo.gl" && url.pathname.startsWith("/maps")) ||
        (/^(www\.|maps\.)?google\.(com|cn|co\.jp|co\.uk|com\.hk|com\.tw)$/.test(host) && url.pathname.startsWith("/maps"))) {
      return PLATFORMS.googlemaps;
    }
    for (const [domains, id] of DOMAINS) {
      if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return PLATFORMS[id];
    }
  } catch { /* 未知或无效 URL 显示通用链接。 */ }
  return PLATFORMS.link;
}

export function platformById(id: string): Platform {
  return PLATFORMS[id] ?? PLATFORMS.link;
}

export const ALL_PLATFORM_IDS = Object.keys(PLATFORMS);
