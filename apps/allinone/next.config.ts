import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 旅行攻略照片上传走 Server Action（浏览器已压缩到长边 1600 的 JPEG，多张一包）。
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
  // public/framelab 是静态目录，Next 不解析目录 index：把入口重写到 index.html。
  async rewrites() {
    return [
      { source: "/framelab", destination: "/framelab/index.html" },
      { source: "/framelab/", destination: "/framelab/index.html" },
      { source: "/qrlab", destination: "/qrlab/index.html" },
      { source: "/qrlab/", destination: "/qrlab/index.html" },
      { source: "/collage", destination: "/collage/index.html" },
      { source: "/collage/", destination: "/collage/index.html" },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
