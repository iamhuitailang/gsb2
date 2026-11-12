<template>
  <div>
    <header class="topbar">
      <h1>网页采集与变更追踪</h1>
      <nav>
        <RouterLink to="/rules">采集规则</RouterLink>
        <RouterLink to="/runs">运行记录</RouterLink>
        <RouterLink to="/pages">当前页面</RouterLink>
        <RouterLink to="/diff">差异对比</RouterLink>
      </nav>
    </header>
    <main>
      <RouterView />
    </main>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #222; }
.topbar { background: #1f2937; color: #fff; padding: 0 24px; display: flex; align-items: center; gap: 32px; }
.topbar h1 { font-size: 18px; }
.topbar nav { display: flex; gap: 4px; }
.topbar a { color: #cbd5e1; text-decoration: none; padding: 16px 14px; font-size: 14px; }
.topbar a.router-link-active { color: #fff; border-bottom: 2px solid #60a5fa; }
main { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
.card { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eee; }
th { color: #666; font-weight: 600; }
button { background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer; font-size: 14px; }
button.secondary { background: #e5e7eb; color: #333; }
button:disabled { opacity: .5; cursor: default; }
label { display: block; margin: 10px 0 4px; font-size: 13px; color: #555; }
input, select { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; }
.badge.new, .badge.appeared { background: #dcfce7; color: #15803d; }
.badge.changed, .badge.modified { background: #fef9c3; color: #a16207; }
.badge.unchanged, .badge.same { background: #f1f5f9; color: #64748b; }
.badge.removed, .badge.disappeared { background: #fee2e2; color: #b91c1c; }
.badge.failed { background: #fee2e2; color: #b91c1c; }
.badge.running { background: #dbeafe; color: #1d4ed8; }
.badge.done { background: #dcfce7; color: #15803d; }
.stat { display: inline-block; margin-right: 24px; }
.stat .num { font-size: 28px; font-weight: 700; }
.stat .lbl { font-size: 12px; color: #888; }
a.link { color: #2563eb; cursor: pointer; text-decoration: none; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
</style>
