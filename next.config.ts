import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  devIndicators: false,
  // Emits .next/standalone with a minimal server.js for the Docker image
  output: "standalone",
}

export default nextConfig
