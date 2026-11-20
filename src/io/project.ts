import type { TerrainProjectData } from "../core/types";
import { TerrainModel } from "../core/TerrainModel";

/**
 * 工程文件（.ttp.json，Terrain Terrain Project）读写。
 * 文件为 UTF-8 JSON，高度/颜色 Float32 数据以 base64 内嵌，
 * 不依赖任何外部资源；seed 随文件保存，重开结果保持一致。
 */

export const PROJECT_MIME = "application/json";
export const PROJECT_EXT = ".ttp.json";

export function serializeProject(model: TerrainModel): string {
  const data = model.toProjectData();
  return JSON.stringify(data, null, 2);
}

export function parseProject(text: string): TerrainModel {
  const data = JSON.parse(text) as TerrainProjectData;
  if (data.version !== 1) {
    throw new Error(`不支持的工程文件版本: ${data.version}`);
  }
  if (!Array.isArray(data.layers) || data.layers.length === 0) {
    throw new Error("工程文件缺少图层数据");
  }
  return TerrainModel.fromProjectData(data);
}

export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickTextFile(accept: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error("未选择文件"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
      reader.readAsText(file);
    };
    input.click();
  });
}
