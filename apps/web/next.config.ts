import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@igtrack/core", "@igtrack/database", "@igtrack/ingestion"],
  experimental: {
    optimizePackageImports: ["@igtrack/core", "@igtrack/database"],
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
