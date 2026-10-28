// 坐标系转换纯函数：行程统一存储 GCJ-02（兼容历史默认高德落点），
// OSM（WGS-84）渲染前 gcj→wgs、点击后 wgs→gcj；高德渲染/点击直用存储值。
// 转换为国测 GCJ-02 标准偏移算法；中国境外两种坐标一致，直接原样返回。

export type LatLng = { lat: number; lng: number };

export type TileId = "amap" | "osm";

const PI = Math.PI;
const A = 6378245; // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594326; // 第一偏心率平方

// 中国大陆概略范围（coordtransform 通用边界）。
export function isInChina(p: LatLng): boolean {
  return p.lng >= 72.004 && p.lng <= 137.8347 && p.lat >= 0.8293 && p.lat <= 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return ret;
}

// WGS-84 → GCJ-02。境外原样返回。
export function wgs84ToGcj02(p: LatLng): LatLng {
  if (!isInChina(p)) return p;
  const x = p.lng - 105;
  const y = p.lat - 35;
  const dLat = transformLat(x, y);
  const dLng = transformLng(x, y);
  const radLat = (p.lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  return {
    lat: p.lat + (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI),
    lng: p.lng + (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI),
  };
}

// GCJ-02 → WGS-84：以正向变换迭代求逆（收敛到毫米级）。境外原样返回。
export function gcj02ToWgs84(p: LatLng): LatLng {
  if (!isInChina(p)) return p;
  let wgs: LatLng = { ...p };
  for (let i = 0; i < 6; i++) {
    const gcj = wgs84ToGcj02(wgs);
    wgs = {
      lat: wgs.lat - (gcj.lat - p.lat),
      lng: wgs.lng - (gcj.lng - p.lng),
    };
  }
  return wgs;
}

// 存储值（GCJ-02）→ 当前底图渲染坐标。
export function storageToTile(tile: TileId, p: LatLng): LatLng {
  return tile === "osm" ? gcj02ToWgs84(p) : p;
}

// 当前底图点击坐标 → 存储值（GCJ-02）。
export function tileToStorage(tile: TileId, p: LatLng): LatLng {
  return tile === "osm" ? wgs84ToGcj02(p) : p;
}
