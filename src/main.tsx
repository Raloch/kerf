import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./ui/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root 挂载点");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// `?autorun=m0` 之类：跑完自检把结果 POST 回开发服务器，砍掉真机调试的往返成本。
// dev 专用，且接收端是 Vite 中间件——构建产物里连那个路由都不存在
if (import.meta.env.DEV) {
  void import("./dev/autorun").then((m) => m.maybeAutorun());
}
