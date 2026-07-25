import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: {
    // 导出 Worker 用 ESM，才能直接 import mediabunny
    format: "es",
  },
  test: {
    // 时间基是纯计算，不需要浏览器环境
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
