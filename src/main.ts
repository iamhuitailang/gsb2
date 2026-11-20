import "./styles.css";
import { Editor } from "./Editor";

const container = document.getElementById("app");
if (!container) throw new Error("缺少 #app 挂载节点");

try {
  const editor = new Editor(container);
  // 调试入口：浏览器控制台可通过 window.__editor 检查运行时状态
  (window as unknown as { __editor: unknown }).__editor = editor;
} catch (err) {
  container.innerHTML = "";
  const box = document.createElement("div");
  box.style.padding = "24px";
  box.style.color = "#e06060";
  box.textContent = "编辑器启动失败：" + (err instanceof Error ? err.message : String(err));
  container.appendChild(box);
}
