import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 附件批量上传最多 30MB，额外预留 multipart 开销；业务层逐文件校验。
  experimental: {
    serverActions: {
      bodySizeLimit: "35mb",
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
