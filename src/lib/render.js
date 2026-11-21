/**
 * 单个输出的渲染 + 编码 + 说明生成。
 * 浏览器与 Node CLI 共用；deflate 由调用方注入，避免绑定运行环境。
 */

import { buildOutput } from "./imaging.js";
import { encodePng } from "./png.js";
import { buildSourceReport } from "./report.js";
import { CHANNEL_IDS, getOutputType } from "./constants.js";

/**
 * @param {object} params
 * @param {object} params.material
 * @param {object} params.output
 * @param {{width:number,height:number,fitMode:string}} params.size
 * @param {Map<string,object>} params.images role -> {width,height,data,fileName,error?}
 * @param {(bytes:Uint8Array)=>Promise<Uint8Array>|Uint8Array} [params.deflate]
 * @param {boolean} [params.failOnDecodeError]
 *   批量导出时为 true：来源文件存在但无法解码 -> 该项直接失败，并记录原因。
 *   缺图（没有文件）始终按常量补齐（需求 1）。预览时为 false，便于看到补齐结果。
 * @returns {Promise<{png:Uint8Array,build:object,sources:object[],reportText:string,warnings:string[]}>}
 */
export async function renderOutputItem({
  material,
  output,
  size,
  images,
  deflate,
  failOnDecodeError = false,
  generatedAt = new Date(),
}) {
  const get = (role) => (images.get ? images.get(role) : images[role]);

  if (failOnDecodeError) {
    for (const id of CHANNEL_IDS) {
      const def = output.channels?.[id];
      if (def?.source?.kind !== "role") continue;
      // 未启用的 Alpha 不会读取来源，其解码失败不应让整项导出失败
      if (id === "a" && !output.includeAlpha) continue;
      const img = get(def.source.role);
      if (img?.error) {
        throw new Error(
          `${id.toUpperCase()} 通道来源「${def.source.role}」${img.fileName ? `（${img.fileName}）` : ""}无法解码：${img.error}`,
        );
      }
    }
  }

  const resolveImage = (role) => {
    const img = get(role);
    if (!img || img.needsRebind) {
      const err = new Error(`未找到「${role}」贴图`);
      err.code = "MISSING_SOURCE";
      throw err;
    }
    if (img.error) {
      // 预览模式：让 buildOutput 记录「解码失败，已用常量补齐」
      const err = new Error(img.error);
      err.code = "DECODE_FAILED";
      throw err;
    }
    return img;
  };

  const build = buildOutput({
    width: size.width,
    height: size.height,
    fitMode: size.fitMode,
    convention: output.convention,
    channels: output.channels,
    includeAlpha: output.includeAlpha,
    resolveImage,
  });

  if (
    getOutputType(output.type).id === "normal" &&
    !build.channels.some((c) => c.role === "normal" && !c.usedConstant)
  ) {
    build.warnings.push("法线输出没有任何可用的法线贴图来源，结果可能为常量色");
  }

  const png = await encodePng({ width: build.width, height: build.height, data: build.data }, { deflate });

  const reportText = buildSourceReport({
    material,
    output: { ...output, fileStem: output.fileStem || output.name, name: output.name },
    size,
    build,
    generatedAt,
  });

  return { png, build, sources: build.channels, reportText, warnings: build.warnings };
}
