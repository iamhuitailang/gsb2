"""核心链路冒烟测试：合成 -> 拉正 -> 检测 -> 网格 -> 导出 -> 自检。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2

from slicer.exporter import export_cells
from slicer.geometry import deskew
from slicer.detection import detect_lines
from slicer.grid import GridModel
from slicer.synth import default_spec, generate
from slicer.verify import verify

work = Path(__file__).resolve().parent / "_smoke"
work.mkdir(exist_ok=True)

spec = default_spec()
img_path = work / "sample.png"
truth = generate(spec, img_path)
print("generated", img_path, "truth cells:", len(truth["cells"]))

image = cv2.imread(str(img_path))
deskewed, rot = deskew(image)
cv2.imwrite(str(work / "deskewed.png"), deskewed)
print("rotation detected:", round(rot.angle, 3), "true:", spec.rotation_deg)

det = detect_lines(deskewed)
print("xs:", [round(x) for x in det.xs])
print("ys:", [round(y) for y in det.ys])
print("grid:", len(det.ys) - 1, "rows x", len(det.xs) - 1, "cols")
print("low confidence items:", len(det.low_confidence))

model = GridModel(det)
print("detected cells:", len(model.cells))
for c in model.cells:
    print(" ", c.code, c.span, c.confidence)

res = export_cells(deskewed, model, work / "export", "sample.png")
print("exported:", res.n_cells, "blank:", res.n_blank)

report = verify(model, rot, work / "sample.truth.json")
print(json.dumps(report, ensure_ascii=False, indent=2))
