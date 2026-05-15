import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // App Router is GA in 15; nothing experimental needed for the streaming
    // text pattern. Server Actions are on by default.
  },
};

export default nextConfig;
