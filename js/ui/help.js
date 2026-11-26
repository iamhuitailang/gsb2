/* 帮助弹窗内容 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});

  const HTML = `
  <h3>这是什么工具？</h3>
  <p>一个完全本地运行、零外部依赖的动态图形标题工坊：在画布上摆放<b>文字、矩形、图片</b>，
  在时间线上为<b>位置、大小（缩放）、宽高、旋转、透明度</b>设置关键帧与缓动，
  最后导出带透明通道的 <b>PNG 图片序列（ZIP）</b> 或 <b>WebM 视频</b>。</p>

  <h3>建议启动方式</h3>
  <p>推荐在项目目录执行 <code>python3 tools/studio_server.py 8123</code>，浏览器打开
  <code>http://127.0.0.1:8123</code>（它同时提供静态托管与一键 ffmpeg 透明视频合成）；
  macOS 也可以双击目录中的 <code>启动工具.command</code>。
  只用 <code>python3 -m http.server 8123</code> 也能编辑和导出 PNG 序列，
  但 App 内一键透明视频需要 ffmpeg 编码服务，否则回退为浏览器实时录制（可能不含 alpha）。
  直接双击 index.html 同样能打开，个别浏览器在 file:// 下会限制 canvas 导出。推荐桌面版 Chrome / Edge。</p>

  <h3>核心操作</h3>
  <table>
    <tr><th>操作</th><th>方式</th></tr>
    <tr><td>添加图层</td><td>左上面板「＋ 文字 / ＋ 矩形 / ＋ 图片」，图片从本地选择并以内嵌 dataURL 保存</td></tr>
    <tr><td>选择 / 多选</td><td>画布点选；图层行点击，⌘/Ctrl+点击 增减选，Shift+点击 范围选</td></tr>
    <tr><td>移动 / 缩放 / 旋转</td><td>画布内拖动主体移动；拖动白色方块改宽高；拖动青色圆点旋转（旋转时按 Shift 吸附 15°）</td></tr>
    <tr><td>关键帧</td><td>把播放头移到某时刻，点击检查器或时间线属性行的 <b>◆</b>；改数值会按「自动关键帧」设置自动打点</td></tr>
    <tr><td>缓动</td><td>点击时间线上的 ◆，在右侧「关键帧」面板选择缓动（线性 / 缓入缓出 / 回弹 / 弹性等）</td></tr>
    <tr><td>调整动画时长</td><td>左右拖动关键帧 ◆（自动帧吸附）；拖动片段条两端可改入点/出点时长</td></tr>
    <tr><td>编组 / 隐藏 / 锁定</td><td>图层面板底部「编组」，每行有眼睛与锁；编组的隐藏/锁定批量作用于子图层；可拖拽图层到编组上</td></tr>
    <tr><td>安全区 / 尺寸</td><td>画布上方切换 93% 动作安全区、90% 标题安全区与三分线；切换输出尺寸时元素位置按画布宽高比换算</td></tr>
  </table>

  <h3>快捷键</h3>
  <p>
    <code>空格</code> 播放/暂停 · <code>⌘/Ctrl+Z</code> 撤销 · <code>⌘/Ctrl+Shift+Z</code> 重做 ·
    <code>⌘/Ctrl+G</code> 编组 · <code>⌘/Ctrl+Shift+G</code> 取消编组 ·
    <code>⌘/Ctrl+D</code> 复制 · <code>Delete/Backspace</code> 删除 ·
    <code>⌘/Ctrl+S</code> 保存工程 · <code>⌘/Ctrl+O</code> 打开工程
  </p>

  <h3>保存工程，以后继续编辑</h3>
  <p>顶部「保存工程」会下载 <code>工程名.mgs.json</code>（图片已内嵌，单文件自包含）；
  「打开工程」选择该文件即可完整恢复时间线与关键帧。编辑内容还会自动暂存在浏览器 localStorage，
  刷新页面后自动恢复。</p>

  <h3>导出透明 PNG 图片序列</h3>
  <p>点「导出图片序列」，得到 ZIP：其中 <code>frames/frame_0001.png …</code> 为带 alpha 通道的 PNG，
  帧数严格等于 <code>round(时长 × 帧率)</code>，并附 <code>README_导出说明.txt</code>。
  导出顺序与画布/图层面板顺序使用同一个渲染函数，所见即所出。</p>

  <h3>导出透明视频</h3>
  <p>方式一（内置）：点「导出透明视频」，得到 WebM。请使用桌面 Chrome/Edge 以保留 VP8/VP9 alpha 通道；
  Safari 或部分环境可能不写 alpha（背景变黑），此时请用方式二。</p>
  <p>方式二（PNG 序列 + ffmpeg，质量与兼容性最好）。安装 ffmpeg 后，在解压目录执行：</p>
  <pre># ProRes 4444 .mov（透明通道，剪辑软件推荐）
ffmpeg -framerate 30 -i frames/frame_%04d.png -c:v prores_ks \\
  -profile:v 4444 -pix_fmt yuva444p10le output.mov

# VP9 WebM（网页透明背景）
ffmpeg -framerate 30 -i frames/frame_%04d.png \\
  -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 output.webm

# QuickTime Animation .mov（无损 alpha）
ffmpeg -framerate 30 -i frames/frame_%04d.png -c:v qtrle -pix_fmt argb output.mov</pre>
  <p>也可以直接运行仓库里的 <code>tools/frames_to_video.sh 解压后的frames目录 30</code>。
  注意：普通 H.264 MP4 不支持透明通道，透明交付请用 MOV(ProRes4444/qtrle) 或 WebM(VP9)。</p>
  `;

  function init() {
    const body = document.getElementById('helpBody');
    if (body) body.innerHTML = HTML;
    document.getElementById('btnHelp').addEventListener('click', () => {
      document.getElementById('helpModal').hidden = false;
    });
    document.getElementById('helpClose').addEventListener('click', () => {
      document.getElementById('helpModal').hidden = true;
    });
    document.getElementById('helpModal').addEventListener('click', (e) => {
      if (e.target.id === 'helpModal') e.currentTarget.hidden = true;
    });
  }

  G.UI = G.UI || {};
  G.UI.Help = { init };
})();
