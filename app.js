"use strict";
(() => {
  // src/ui/dom.ts
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null) continue;
        if (key === "class") el.className = String(value);
        else if (key === "html") el.innerHTML = String(value);
        else if (key === "text") el.textContent = String(value);
        else if (key === "dataset") {
          for (const [dk, dv] of Object.entries(value)) {
            el.dataset[dk] = String(dv);
          }
        } else if (key === "style" && typeof value === "string") {
          el.style.cssText = value;
        } else if (key === "style" && typeof value === "object") {
          Object.assign(el.style, value);
        } else if (key.startsWith("on") && typeof value === "function") {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === "value") {
          el.value = String(value);
        } else if (key.startsWith("aria-") || key === "role" || key === "for" || key === "accept" || key === "spellcheck") {
          el.setAttribute(key === "for" ? "for" : key, String(value));
        } else {
          try {
            el[key] = value;
          } catch {
            el.setAttribute(key, String(value));
          }
        }
      }
    }
    appendChildren(el, children);
    return el;
  }
  function appendChildren(el, children) {
    for (const child of children) {
      if (child === false || child == null || child === void 0) continue;
      if (Array.isArray(child)) appendChildren(el, child);
      else if (child instanceof Node) el.appendChild(child);
      else el.appendChild(document.createTextNode(String(child)));
    }
  }
  function clear(el) {
    el.replaceChildren();
  }
  function openModal(title, content, opts) {
    const backdrop = h("div", { class: "modal-backdrop" });
    const closeBtn = h("button", { class: "icon-btn", "aria-label": "\u5173\u95ED", onclick: () => close() }, "\u2715");
    const box = h(
      "div",
      { class: `modal${opts?.wide ? " modal-wide" : ""}`, role: "dialog", "aria-modal": "true" },
      h("div", { class: "modal-head" }, h("h3", null, title), closeBtn),
      h("div", { class: "modal-body" }, content)
    );
    backdrop.appendChild(box);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);
    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    }
    return close;
  }

  // src/pool.ts
  var RULES = {
    mainSize: 40,
    sideboardMax: 10,
    defaultCopyLimit: 4,
    coreMin: 1,
    coreMax: 2,
    openingHandSize: 5
  };
  var FACTIONS = {
    crimson: { id: "crimson", name: "\u8D64\u7130", short: "\u8D64", color: "#c93b3b", soft: "#fdecec" },
    tide: { id: "tide", name: "\u82CD\u6F9C", short: "\u6F9C", color: "#1f6fc4", soft: "#e9f2fc" },
    grove: { id: "grove", name: "\u68EE\u7F57", short: "\u68EE", color: "#2f8a4f", soft: "#eaf6ee" },
    neutral: { id: "neutral", name: "\u4E2D\u7ACB", short: "\u4E2D", color: "#4b5563", soft: "#eef1f5" }
  };
  var FACTION_ORDER = ["crimson", "tide", "grove", "neutral"];
  var COMMON_CARDS = [
    // ---- 核心牌：阵营盟约 ----
    {
      id: "core-flame",
      name: "\u8D64\u7130\u76DF\u4E3B\xB7\u70E8",
      faction: "crimson",
      type: "core",
      cost: null,
      limit: 1,
      text: "\u6838\u5FC3 \xB7 \u76DF\u7EA6\u3010\u8D64\u7130\u3011\uFF1A\u540C\u961F\u724C\u7EC4\u4E2D\u53EA\u5141\u8BB8\u51FA\u73B0\u8D64\u7130\u4E0E\u4E2D\u7ACB\u9635\u8425\u3002",
      core: { allied: ["crimson", "neutral"] },
      printings: [
        { id: "core-flame-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" },
        { id: "core-flame-aa", label: "\u5F02\u753B\u85CF\u5370", set: "ALTARTS", since: "1.0", foil: true }
      ]
    },
    {
      id: "core-tide",
      name: "\u82CD\u6F9C\u5973\u738B\xB7\u6C50",
      faction: "tide",
      type: "core",
      cost: null,
      limit: 1,
      text: "\u6838\u5FC3 \xB7 \u76DF\u7EA6\u3010\u82CD\u6F9C\u3011\uFF1A\u540C\u961F\u724C\u7EC4\u4E2D\u53EA\u5141\u8BB8\u51FA\u73B0\u82CD\u6F9C\u4E0E\u4E2D\u7ACB\u9635\u8425\u3002",
      core: { allied: ["tide", "neutral"] },
      printings: [{ id: "core-tide-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "core-wild",
      name: "\u68EE\u7F57\u53E4\u7075\xB7\u82D4",
      faction: "grove",
      type: "core",
      cost: null,
      limit: 1,
      text: "\u6838\u5FC3 \xB7 \u76DF\u7EA6\u3010\u68EE\u7F57\u3011\uFF1A\u540C\u961F\u724C\u7EC4\u4E2D\u53EA\u5141\u8BB8\u51FA\u73B0\u68EE\u7F57\u4E0E\u4E2D\u7ACB\u9635\u8425\u3002",
      core: { allied: ["grove", "neutral"] },
      printings: [{ id: "core-wild-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "core-pact",
      name: "\u7194\u6F6E\u76DF\u6838\xB7\u7131\u6C50",
      faction: "neutral",
      type: "core",
      cost: null,
      limit: 1,
      text: "\u6838\u5FC3 \xB7 \u76DF\u7EA6\u3010\u7194\u6F6E\u3011\uFF1A\u5141\u8BB8\u8D64\u7130\u3001\u82CD\u6F9C\u4E0E\u4E2D\u7ACB\u540C\u961F\uFF08\u4E0D\u5141\u8BB8\u68EE\u7F57\uFF09\u3002",
      core: { allied: ["crimson", "tide", "neutral"] },
      printings: [{ id: "core-pact-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    // ---- 赤焰 ----
    {
      id: "c-recruit",
      name: "\u8D64\u7130\u65B0\u5175",
      faction: "crimson",
      type: "unit",
      cost: 1,
      limit: 4,
      text: "\u51B2\u950B\uFF1A\u5165\u573A\u5F53\u56DE\u5408\u53EF\u653B\u51FB\u3002",
      printings: [{ id: "c-recruit-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "c-blade",
      name: "\u708E\u5203\u5251\u58EB",
      faction: "crimson",
      type: "unit",
      cost: 2,
      limit: 4,
      text: "\u653B\u51FB\u65F6\u9644\u52A0 1 \u70B9\u707C\u70E7\u3002",
      printings: [
        { id: "c-blade-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" },
        { id: "c-blade-aa", label: "\u5F02\u753B\u85CF\u5370", set: "ALTARTS", since: "1.0", foil: true },
        { id: "c-blade-neo", label: "\u65B0\u7EAA\u5143\u91CD\u7ED8", set: "NEO", since: "2.0" }
      ]
    },
    {
      id: "c-oath",
      name: "\u8A93\u7EA6\u9A91\u58EB",
      faction: "crimson",
      type: "unit",
      cost: 3,
      limit: 4,
      text: "\u8D77\u624B\u8A93\u7EA6\uFF1A\u5F00\u5C40\u8D77\u624B\u4E2D\u53E6\u6709\u81F3\u5C11 2 \u5F20\u8D64\u7130\u724C\u65F6\uFF0C\u6B64\u724C\u624D\u6709\u51FA\u573A\u8D44\u683C\uFF081 \u8D39\u51B2\u950B\uFF09\u3002",
      opening: {
        kind: "faction-other",
        faction: "crimson",
        count: 2,
        text: "\u8D77\u624B\u4E2D\u53E6\u6709\u81F3\u5C11 2 \u5F20\u8D64\u7130\u9635\u8425\u724C"
      },
      printings: [
        { id: "c-oath-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" },
        { id: "c-oath-aa", label: "\u5F02\u753B\u85CF\u5370", set: "ALTARTS", since: "1.0", foil: true }
      ]
    },
    {
      id: "c-arrow",
      name: "\u706B\u7BAD\u9F50\u5C04",
      faction: "crimson",
      type: "spell",
      cost: 2,
      limit: 4,
      text: "\u5BF9\u4E00\u4E2A\u76EE\u6807\u9020\u6210 3 \u70B9\u4F24\u5BB3\u3002",
      printings: [{ id: "c-arrow-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "c-berzerker",
      name: "\u72C2\u65A7\u624B",
      faction: "crimson",
      type: "unit",
      cost: 3,
      limit: 4,
      text: "\u8840\u91CF\u8D8A\u4F4E\uFF0C\u653B\u51FB\u529B\u8D8A\u9AD8\u3002",
      printings: [{ id: "c-berzerker-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "c-drake",
      name: "\u5E7C\u7130\u9F99",
      faction: "crimson",
      type: "unit",
      cost: 4,
      limit: 4,
      text: "\u767B\u573A\uFF1A\u5BF9\u6240\u6709\u654C\u65B9\u968F\u4ECE\u9020\u6210 1 \u70B9\u707C\u70E7\u3002",
      printings: [{ id: "c-drake-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "c-phoenix",
      name: "\u4E0D\u6B7B\u51E4\u51F0",
      faction: "crimson",
      type: "unit",
      cost: 5,
      limit: 4,
      text: "\u6B7B\u4EA1\u540E\u4EE5 1 \u8840\u5F62\u6001\u590D\u6D3B\u4E00\u6B21\u3002",
      printings: [{ id: "c-phoenix-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    // ---- 苍澜 ----
    {
      id: "t-mist",
      name: "\u8FF7\u96FE\u6C34\u624B",
      faction: "tide",
      type: "unit",
      cost: 1,
      limit: 4,
      text: "\u6F5C\u884C\uFF1A\u9996\u6B21\u653B\u51FB\u524D\u4E0D\u53EF\u88AB\u6307\u5B9A\u3002",
      printings: [{ id: "t-mist-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "t-warden",
      name: "\u6F6E\u536B",
      faction: "tide",
      type: "unit",
      cost: 2,
      limit: 4,
      text: "\u62A4\u536B\uFF1A\u76F8\u90BB\u53CB\u519B\u4E0D\u4F1A\u88AB\u8FDC\u7A0B\u653B\u51FB\u3002",
      printings: [
        { id: "t-warden-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" },
        { id: "t-warden-aa", label: "\u5F02\u753B\u85CF\u5370", set: "ALTARTS", since: "1.0", foil: true }
      ]
    },
    {
      id: "t-frost",
      name: "\u5BD2\u971C\u56DE\u54CD",
      faction: "tide",
      type: "spell",
      cost: 2,
      limit: 4,
      text: "\u51BB\u7ED3\u4E00\u4E2A\u76EE\u6807\uFF0C\u5E76\u62BD\u4E00\u5F20\u724C\u3002",
      printings: [{ id: "t-frost-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "t-siren",
      name: "\u6DF1\u6F6E\u6B4C\u8005",
      faction: "tide",
      type: "unit",
      cost: 3,
      limit: 4,
      text: "\u51FA\u573A\u8D44\u683C\uFF1A\u8D77\u624B\u4E2D\u53E6\u6709\u81F3\u5C11 1 \u5F20\u82CD\u6F9C\u724C\u6765\u548C\u6B4C\u3002",
      opening: {
        kind: "faction-other",
        faction: "tide",
        count: 1,
        text: "\u8D77\u624B\u4E2D\u53E6\u6709\u81F3\u5C11 1 \u5F20\u82CD\u6F9C\u9635\u8425\u724C"
      },
      printings: [{ id: "t-siren-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "t-oracle",
      name: "\u795E\u8C15\u8005",
      faction: "tide",
      type: "unit",
      cost: 3,
      limit: 4,
      text: "\u9884\u8A00\uFF1A\u67E5\u770B\u724C\u5E93\u9876\u4E09\u5F20\u724C\u5E76\u653E\u56DE\u3002",
      printings: [{ id: "t-oracle-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "t-kraken",
      name: "\u6DF1\u6E0A\u5DE8\u9C7F",
      faction: "tide",
      type: "unit",
      cost: 6,
      limit: 1,
      text: "\u4F20\u8BF4 \xB7 \u767B\u573A\uFF1A\u6DF9\u6CA1\u5BF9\u65B9\u534A\u573A\u3002",
      printings: [{ id: "t-kraken-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    // ---- 森罗 ----
    {
      id: "g-archer",
      name: "\u6797\u54E8\u5F13\u624B",
      faction: "grove",
      type: "unit",
      cost: 1,
      limit: 4,
      text: "\u8FDC\u7A0B\uFF1A\u53EF\u76F4\u63A5\u653B\u51FB\u540E\u6392\u3002",
      printings: [
        { id: "g-archer-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" },
        { id: "g-archer-aa", label: "\u5F02\u753B\u85CF\u5370", set: "ALTARTS", since: "1.0", foil: true }
      ]
    },
    {
      id: "g-vine",
      name: "\u7F20\u7ED5\u85E4\u8513",
      faction: "grove",
      type: "spell",
      cost: 1,
      limit: 4,
      text: "\u675F\u7F1A\u4E00\u4E2A\u76EE\u6807\u4E24\u56DE\u5408\u3002",
      printings: [{ id: "g-vine-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "g-wolf",
      name: "\u62A4\u6797\u72FC",
      faction: "grove",
      type: "unit",
      cost: 2,
      limit: 4,
      text: "\u7ED3\u4F34\uFF1A\u8D77\u624B\u4E2D\u6709\u300C\u6797\u54E8\u5F13\u624B\u300D\u65F6\u624D\u83B7\u5F97\u51FA\u573A\u8D44\u683C\uFF0C\u5E76\u80A9\u4F5C\u6218 +2 \u653B\u3002",
      opening: { kind: "partner", partnerId: "g-archer", text: "\u8D77\u624B\u4E2D\u540C\u65F6\u6301\u6709\u300C\u6797\u54E8\u5F13\u624B\u300D" },
      printings: [{ id: "g-wolf-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "g-guardian",
      name: "\u7FE0\u6797\u5B88\u536B",
      faction: "grove",
      type: "unit",
      cost: 3,
      limit: 4,
      text: "\u5632\u8BBD\uFF0C\u8346\u68D8 2\u3002",
      printings: [{ id: "g-guardian-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "g-treant",
      name: "\u53E4\u6811\u4EBA",
      faction: "grove",
      type: "unit",
      cost: 4,
      limit: 4,
      text: "\u56DE\u5408\u7ED3\u675F\u65F6\u6062\u590D 2 \u70B9\u751F\u547D\u3002",
      printings: [{ id: "g-treant-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    // ---- 中立 ----
    {
      id: "n-courier",
      name: "\u884C\u5546",
      faction: "neutral",
      type: "unit",
      cost: 1,
      limit: 4,
      text: "\u8FDB\u573A\uFF1A\u62BD\u4E00\u5F20\u724C\u3002",
      printings: [{ id: "n-courier-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "n-lantern",
      name: "\u5F15\u8DEF\u706F",
      faction: "neutral",
      type: "relic",
      cost: 1,
      limit: 4,
      text: "\u4F7F\u4E00\u4E2A\u968F\u4ECE\u672C\u56DE\u5408\u83B7\u5F97\u5148\u950B\u3002",
      printings: [{ id: "n-lantern-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "n-golem",
      name: "\u65B9\u7247\u9B54\u50CF",
      faction: "neutral",
      type: "unit",
      cost: 3,
      limit: 4,
      text: "\u6784\u88C5\u4F53\uFF0C\u6CA1\u6709\u9635\u8425\uFF0C\u4E0D\u53D7\u76DF\u7EA6\u9650\u5236\u3002",
      printings: [
        { id: "n-golem-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" },
        { id: "n-golem-aa", label: "\u5F02\u753B\u85CF\u5370", set: "ALTARTS", since: "1.0" }
      ]
    },
    {
      id: "n-scholar",
      name: "\u535A\u5B66\u8005",
      faction: "neutral",
      type: "unit",
      cost: 2,
      limit: 4,
      text: "\u8FDB\u573A\uFF1A\u67E5\u770B\u724C\u5E93\u9876\u4E24\u5F20\u724C\u3002",
      printings: [{ id: "n-scholar-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "n-smith",
      name: "\u953B\u7089\u5320",
      faction: "neutral",
      type: "unit",
      cost: 2,
      limit: 4,
      text: "\u6218\u543C\uFF1A\u4F7F\u624B\u724C\u4E2D\u4E00\u5F20\u6B66\u5668\u724C -1 \u8D39\u3002",
      printings: [{ id: "n-smith-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "n-wish",
      name: "\u8BB8\u613F\u65B9\u7247",
      faction: "neutral",
      type: "spell",
      cost: 2,
      limit: 4,
      text: "\u9009\u62E9\uFF1A\u56DE 3 \u8840\uFF0C\u6216\u83B7\u5F97\u4E00\u4E2A\u7A7A\u6CD5\u529B\u6C34\u6676\u3002",
      printings: [{ id: "n-wish-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    // ---- 传说组合技 ----
    {
      id: "d-day",
      name: "\u53CC\u751F\xB7\u663C",
      faction: "neutral",
      type: "unit",
      cost: 3,
      limit: 1,
      text: "\u4F20\u8BF4 \xB7 \u53CC\u751F\uFF1A\u8D77\u624B\u4E2D\u540C\u65F6\u6709\u300C\u53CC\u751F\xB7\u591C\u300D\u65F6\uFF0C\u4E24\u724C\u624D\u90FD\u5177\u6709\u51FA\u573A\u8D44\u683C\uFF0C\u8054\u624B\u9020\u6210 6 \u70B9\u4F24\u5BB3\u3002",
      opening: { kind: "partner", partnerId: "d-night", text: "\u8D77\u624B\u4E2D\u540C\u65F6\u6301\u6709\u300C\u53CC\u751F\xB7\u591C\u300D" },
      printings: [{ id: "d-day-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    },
    {
      id: "d-night",
      name: "\u53CC\u751F\xB7\u591C",
      faction: "neutral",
      type: "unit",
      cost: 3,
      limit: 1,
      text: "\u4F20\u8BF4 \xB7 \u53CC\u751F\uFF1A\u8D77\u624B\u4E2D\u540C\u65F6\u6709\u300C\u53CC\u751F\xB7\u663C\u300D\u65F6\uFF0C\u4E24\u724C\u624D\u90FD\u5177\u6709\u51FA\u573A\u8D44\u683C\uFF0C\u8054\u624B\u9020\u6210 6 \u70B9\u4F24\u5BB3\u3002",
      opening: { kind: "partner", partnerId: "d-day", text: "\u8D77\u624B\u4E2D\u540C\u65F6\u6301\u6709\u300C\u53CC\u751F\xB7\u663C\u300D" },
      printings: [{ id: "d-night-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" }]
    }
  ];
  var VETERAN_OLD = {
    id: "c-veteran",
    name: "\u8D64\u7130\u8001\u5175",
    faction: "crimson",
    type: "unit",
    cost: 3,
    limit: 4,
    text: "\u65E7\u7248\uFF1A3/4\uFF0C\u6BCF\u56DE\u5408 +1 \u653B\u51FB\u529B\u3002\u5DF2\u5728 2.0 \u9000\u5F79\u3002",
    printings: [
      { id: "c-veteran-o", label: "\u521D\u7248", set: "ORIGIN", since: "1.0" },
      { id: "c-veteran-foil", label: "\u95EA\u5370\u7EAA\u5FF5", set: "PROMO", since: "1.0", foil: true }
    ]
  };
  var VETERAN_NEW = {
    id: "c-veteran-neo",
    name: "\u8D64\u7130\u8001\u5175",
    faction: "crimson",
    type: "unit",
    cost: 2,
    limit: 4,
    text: "\u65B0\u7248\u91CD\u505A\uFF1A2/2\uFF0C\u6218\u543C\u9020\u6210 1 \u70B9\u4F24\u5BB3\uFF08\u4E0E\u65E7\u7248\u4E0D\u662F\u540C\u4E00\u5F20\u724C\uFF09\u3002",
    printings: [{ id: "c-veteran-neo-o", label: "\u65B0\u7EAA\u5143", set: "NEO", since: "2.0" }]
  };
  function makePool(version, label, released, cards) {
    return { version, label, released, cards, cardById: new Map(cards.map((c) => [c.id, c])) };
  }
  var POOL_V1 = makePool("1.0", "\u521B\u4E16\u521D\u5370", "\u865A\u6784 2024", [...COMMON_CARDS, VETERAN_OLD]);
  var POOL_V2 = makePool("2.0", "\u65B0\u7EAA\u5143", "\u865A\u6784 2026", [...COMMON_CARDS, VETERAN_NEW]);
  var CURRENT_POOL = POOL_V2;
  function defaultPrinting(card) {
    return card.printings[0]?.id ?? "";
  }

  // src/defaultDecks.ts
  var seq = 0;
  function genUid(prefix = "u") {
    seq += 1;
    return `${prefix}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }
  function entries(specs, zone) {
    return specs.map(([cardId, count2, printingId, uid]) => {
      const card = CURRENT_POOL.cardById.get(cardId);
      const e = {
        kind: "entry",
        uid: uid ?? genUid(zone === "main" ? "m" : "s"),
        cardId,
        printingId: printingId ?? (card ? defaultPrinting(card) : "unknown"),
        count: count2
      };
      return e;
    });
  }
  function deck(d) {
    return {
      ...d,
      builtin: true,
      main: entries(d.main, "main"),
      sideboard: entries(d.sideboard ?? [], "sideboard")
    };
  }
  var DEFAULT_DECKS = [
    deck({
      id: "deck-aggro",
      name: "\u8D64\u7130\u5FEB\u653B\uFF08\u5408\u89C4\u6837\u677F\uFF09",
      tag: "\u5408\u89C4 \xB7 \u5FEB\u653B",
      description: "40 \u5F20\u4E3B\u724C + 7 \u5F20\u5907\u9009\uFF0C\u8D64\u7130\u76DF\u7EA6\uFF0C\u66F2\u7EBF\u4F4E\uFF0C\u8A93\u7EA6\u9A91\u58EB\u5BB9\u6613\u8FBE\u6210\u51FA\u573A\u6761\u4EF6\u3002",
      goal: {
        kind: "card-enabled",
        cardId: "c-oath",
        label: "\u8A93\u7EA6\u9A91\u58EB\u5728\u624B\uFF0C\u4E14\u8D77\u624B\u53E6\u6709 \u22652 \u5F20\u8D64\u7130\u724C"
      },
      main: [
        ["core-flame", 1, void 0, "aggro-core"],
        ["c-recruit", 4],
        ["c-blade", 4, "c-blade-o", "aggro-blade"],
        ["c-oath", 4],
        ["c-arrow", 4],
        ["c-berzerker", 4],
        ["c-drake", 3],
        ["n-courier", 4],
        ["n-scholar", 4],
        ["n-smith", 4],
        ["n-golem", 4]
      ],
      sideboard: [
        ["t-warden", 2, "t-warden-o", "aggro-warden"],
        ["core-pact", 1, void 0, "aggro-pact"],
        ["c-phoenix", 2],
        ["n-wish", 2]
      ]
    }),
    deck({
      id: "deck-cycle",
      name: "\u56DB\u5370\u8F6E\u8F6C\uFF08\u5355\u6362\u5931\u8D25 / \u6574\u6279\u5408\u6CD5\uFF09",
      tag: "\u4EA4\u6362\u793A\u4F8B",
      description: "\u708E\u5203\u5251\u58EB\u4E0E\u8A93\u7EA6\u9A91\u58EB\u5728\u4E3B\u724C\u90FD\u5DF2\u6EE1 4 \u5F20\uFF0C\u5907\u9009\u5404\u653E\u4E86 1 \u5F20\u5F02\u753B\u5370\u6B21\u3002\u4E24\u5BF9\u4E92\u6362\u5355\u72EC\u6267\u884C\u90FD\u4F1A\u649E\u540C\u540D\u4E0A\u9650\uFF0C\u4E24\u5BF9\u4E00\u8D77\u6362\u5219\u603B\u6570\u4E0D\u53D8\u3001\u6574\u6279\u5408\u6CD5\u3002",
      pitfall: "\u8BD5\u8BD5\u4EA4\u6362\u5DE5\u4F5C\u53F0\u91CC\u7684\u9884\u7F6E\u65B9\u6848\uFF1A\u6BCF\u4E00\u5BF9\u5355\u72EC\u6362\u90FD\u5931\u8D25\uFF0C\u4F46\u4E24\u5BF9\u4F5C\u4E3A\u540C\u4E00\u6279\u63D0\u4EA4\u4F1A\u6574\u4F53\u5408\u6CD5\u5E76\u4E00\u6B21\u751F\u6548\u3002",
      goal: {
        kind: "card-enabled",
        cardId: "c-oath",
        label: "\u8A93\u7EA6\u9A91\u58EB\u5728\u624B\uFF0C\u4E14\u8D77\u624B\u53E6\u6709 \u22652 \u5F20\u8D64\u7130\u724C"
      },
      main: [
        ["core-flame", 1],
        ["c-blade", 4, "c-blade-o", "cycle-blade"],
        ["c-oath", 4, "c-oath-o", "cycle-oath"],
        ["c-recruit", 4],
        ["c-arrow", 4],
        ["c-berzerker", 4],
        ["c-drake", 4],
        ["c-phoenix", 4],
        ["n-courier", 4],
        ["n-scholar", 4],
        ["n-golem", 3]
      ],
      sideboard: [
        ["c-oath", 1, "c-oath-aa", "cycle-oath-aa"],
        ["c-blade", 1, "c-blade-aa", "cycle-blade-aa"],
        ["n-wish", 2]
      ]
    }),
    deck({
      id: "deck-faction",
      name: "\u4E09\u8272\u6742\u70E9\uFF08\u6838\u5FC3\u9635\u8425\u8FDD\u89C4\uFF09",
      tag: "\u6545\u610F\u5361\u4F4F \xB7 \u9635\u8425",
      description: "\u5E26\u7740\u8D64\u7130\u76DF\u4E3B\u7684\u76DF\u7EA6\uFF0C\u5374\u585E\u4E86\u82CD\u6F9C\u6F6E\u536B\u548C\u68EE\u7F57\u5F13\u624B\uFF0C\u6838\u5FC3\u4E0D\u5141\u8BB8\u5B83\u4EEC\u540C\u961F\u3002",
      pitfall: "\u6821\u9A8C\u4F1A\u5206\u522B\u6307\u51FA\uFF1A\u82CD\u6F9C\u6F6E\u536B\u3001\u6797\u54E8\u5F13\u624B\u89E6\u4E86 R-CORE-FACTION\uFF0C\u8FDD\u53CD\u8D64\u7130\u76DF\u4E3B\u7684\u76DF\u7EA6\u3002",
      goal: { kind: "faction-count", faction: "crimson", count: 3, label: "\u8D77\u624B\u81F3\u5C11 3 \u5F20\u8D64\u7130\u724C" },
      main: [
        ["core-flame", 1],
        ["c-recruit", 4],
        ["c-blade", 4],
        ["c-arrow", 4],
        ["c-berzerker", 4],
        ["c-drake", 3],
        ["t-warden", 4],
        ["g-archer", 4],
        ["n-courier", 4],
        ["n-scholar", 4],
        ["n-golem", 4]
      ]
    }),
    deck({
      id: "deck-printcap",
      name: "\u4E94\u5F20\u708E\u5203\uFF08\u5370\u6B21\u8D85\u91CF\uFF09",
      tag: "\u6545\u610F\u5361\u4F4F \xB7 \u6570\u91CF\u4E0A\u9650",
      description: "\u708E\u5203\u5251\u58EB\u653E\u4E86 3 \u5F20\u521D\u7248 + 2 \u5F20\u5F02\u753B\u3002\u5370\u6B21\u4E0D\u540C\uFF0C\u4F46\u5171\u4EAB cardId \u4E0E\u603B\u4E0A\u9650 4\u3002",
      pitfall: "R-COPY-LIMIT \u4F1A\u628A\u4E24\u4E2A\u5370\u6B21\u5408\u5E76\u8BA1\u7B97\u4E3A 5/4\uFF0C\u800C\u4E0D\u662F\u628A\u5F02\u753B\u5F53\u6210\u53E6\u4E00\u5F20\u5361\u3002",
      goal: {
        kind: "card-enabled",
        cardId: "c-oath",
        label: "\u8A93\u7EA6\u9A91\u58EB\u5728\u624B\u4E14\u8D44\u683C\u6EE1\u8DB3"
      },
      main: [
        ["core-flame", 1],
        ["c-blade", 3, "c-blade-o", "printcap-blade-o"],
        ["c-blade", 2, "c-blade-aa", "printcap-blade-aa"],
        ["c-recruit", 4],
        ["c-oath", 4],
        ["c-arrow", 4],
        ["c-berzerker", 4],
        ["c-drake", 4],
        ["n-courier", 4],
        ["n-scholar", 4],
        ["n-smith", 2],
        ["n-golem", 4]
      ]
    }),
    deck({
      id: "deck-twocore",
      name: "\u8D64\u84DD\u53CC\u6838\uFF08\u76DF\u7EA6\u4E92\u65A5\uFF09",
      tag: "\u6545\u610F\u5361\u4F4F \xB7 \u53CC\u6838\u5FC3",
      description: "\u5E26\u4E86\u8D64\u7130\u76DF\u4E3B\u4E0E\u82CD\u6F9C\u5973\u738B\u4E24\u679A\u6838\u5FC3\uFF08\u6838\u5FC3\u6570\u91CF 2 \u672C\u8EAB\u5408\u6CD5\uFF09\uFF0C\u4F46\u4E24\u5957\u76DF\u7EA6\u4EA4\u96C6\u53EA\u5269\u4E2D\u7ACB\uFF0C\u724C\u7EC4\u91CC\u7684\u8D64\u7130\u724C\u88AB\u82CD\u6F9C\u5973\u738B\u62D2\u7EDD\u3001\u82CD\u6F9C\u724C\u88AB\u8D64\u7130\u76DF\u4E3B\u62D2\u7EDD\u3002",
      pitfall: "\u9519\u8BEF\u4F1A\u540C\u65F6\u6302\u5230\u300C\u6362\u5165 / \u6D89\u4E8B\u724C\u300D\u548C\u5BF9\u5E94\u6838\u5FC3\u4E0A\uFF0C\u8BF4\u660E\u662F\u54EA\u679A\u6838\u5FC3\u4E0D\u5141\u8BB8\u5B83\u540C\u961F\u3002",
      goal: { kind: "faction-count", faction: "neutral", count: 3, label: "\u8D77\u624B\u81F3\u5C11 3 \u5F20\u4E2D\u7ACB\u724C\uFF08\u4E24\u6838\u4E92\u65A5\u4E0B\u552F\u4E00\u7A33\u59A5\u65B9\u5411\uFF09" },
      main: [
        ["core-flame", 1],
        ["core-tide", 1],
        ["c-blade", 4],
        ["c-recruit", 4],
        ["t-warden", 4],
        ["t-oracle", 4],
        ["n-courier", 4],
        ["n-scholar", 4],
        ["n-smith", 4],
        ["n-golem", 4],
        ["n-wish", 4],
        ["n-lantern", 2]
      ]
    }),
    deck({
      id: "deck-shortsize",
      name: "\u5C11\u4E24\u5F20\uFF08\u4E3B\u724C\u6570\u91CF\u4E0D\u8DB3\uFF09",
      tag: "\u6545\u610F\u5361\u4F4F \xB7 \u724C\u5E93\u6570\u91CF",
      description: "\u53EA\u6709 38 \u5F20\u4E3B\u724C\u3002\u7528\u6765\u89C2\u5BDF\u79FB\u9664\u52A8\u4F5C\u5982\u4F55\u89E6\u53D1 R-DECK-SIZE\uFF0C\u4EE5\u53CA\u4EA4\u6362\u4E3A\u4F55\u5FC5\u987B\u4FDD\u6301 1:1\u3002",
      pitfall: "\u5728\u4EA4\u6362\u5DE5\u4F5C\u53F0\u5C1D\u8BD5\u53EA\u79FB\u8D70\u4E3B\u724C\u3001\u4E0D\u6362\u5165\u5907\u9009\u724C\uFF0C\u9519\u8BEF\u4F1A\u5F52\u5230\u300C\u539F\u724C\u300D\u90A3\u4E00\u5217\u3002",
      goal: { kind: "faction-count", faction: "crimson", count: 3, label: "\u8D77\u624B\u81F3\u5C11 3 \u5F20\u8D64\u7130\u724C" },
      main: [
        ["core-flame", 1],
        ["c-recruit", 4],
        ["c-blade", 4],
        ["c-oath", 4],
        ["c-arrow", 4],
        ["c-berzerker", 4],
        ["c-drake", 3],
        ["n-courier", 4],
        ["n-scholar", 4],
        ["n-smith", 4],
        ["n-golem", 2]
      ]
    }),
    deck({
      id: "deck-combo",
      name: "\u53CC\u751F\u663C\u591C\uFF08\u4F4E\u6982\u7387\u7EC4\u5408\u6280\uFF09",
      tag: "\u79CD\u5B50\u5BF9\u6BD4 \xB7 \u7EC4\u5408",
      description: "\u53CC\u751F\xB7\u663C\u4E0E\u53CC\u751F\xB7\u591C\u5404 1 \u5F20\uFF08\u4F20\u8BF4\u4E0A\u9650 1\uFF09\uFF0C\u8D77\u624B\u540C\u65F6\u62FF\u5230\u624D\u7B97\u5F00\u5C40\u6210\u7ACB\uFF0C\u9002\u5408\u5728\u79CD\u5B50\u5BF9\u6BD4\u91CC\u7FFB\u770B\u5931\u8D25\u8D77\u624B\u3002",
      goal: { kind: "combo", cardIds: ["d-day", "d-night"], label: "\u8D77\u624B\u540C\u65F6\u5305\u542B\u53CC\u751F\xB7\u663C\u4E0E\u53CC\u751F\xB7\u591C" },
      main: [
        ["core-flame", 1],
        ["d-day", 1],
        ["d-night", 1],
        ["c-recruit", 4],
        ["c-blade", 4],
        ["c-oath", 4],
        ["c-arrow", 4],
        ["c-berzerker", 4],
        ["c-drake", 4],
        ["n-courier", 4],
        ["n-scholar", 4],
        ["n-golem", 4],
        ["n-wish", 1]
      ]
    }),
    deck({
      id: "deck-grove",
      name: "\u68EE\u7F57\u4E2D\u901F\uFF08\u9635\u8425\u6570\u91CF\u76EE\u6807\uFF09",
      tag: "\u79CD\u5B50\u5BF9\u6BD4 \xB7 \u4E2D\u901F",
      description: "\u9AD8\u5BC6\u5EA6\u68EE\u7F57\u724C\uFF0C\u5F00\u5C40\u76EE\u6807\u662F\u8D77\u624B\u81F3\u5C11 3 \u5F20\u68EE\u7F57\uFF0C\u62A4\u6797\u72FC\u8FD8\u4F1A\u68C0\u67E5\u8D77\u624B\u91CC\u6709\u6CA1\u6709\u6797\u54E8\u5F13\u624B\u3002",
      goal: { kind: "faction-count", faction: "grove", count: 3, label: "\u8D77\u624B\u81F3\u5C11 3 \u5F20\u68EE\u7F57\u724C" },
      main: [
        ["core-wild", 1],
        ["g-archer", 4],
        ["g-wolf", 4],
        ["g-vine", 4],
        ["g-guardian", 4],
        ["g-treant", 4],
        ["n-courier", 4],
        ["n-scholar", 4],
        ["n-smith", 4],
        ["n-golem", 4],
        ["n-wish", 3]
      ]
    })
  ];
  var PRESET_PLANS = [
    {
      id: "plan-cycle",
      deckId: "deck-cycle",
      name: "\u9650\u91CF\u8F6E\u8F6C\uFF1A\u708E\u5203 \u2194 \u8A93\u7EA6\uFF08\u4E24\u5BF9\u4E00\u6279\uFF09",
      blurb: "\u6BCF\u4E00\u5BF9\u5355\u72EC\u6362\u90FD\u4F1A\u8BA9\u6362\u5165\u724C\u8FBE\u5230 5/4\uFF1B\u4E24\u5BF9\u4E00\u8D77\u6362\u65F6\u4E24\u5F20\u5361\u90FD\u662F \u22121+1\uFF0C\u603B\u6570\u4ECD\u4E3A 4\u3002",
      pairs: [
        { id: "pair-c1", mainUid: "cycle-blade", sideUid: "cycle-oath-aa" },
        { id: "pair-c2", mainUid: "cycle-oath", sideUid: "cycle-blade-aa" }
      ]
    },
    {
      id: "plan-pact",
      deckId: "deck-aggro",
      name: "\u76DF\u7EA6\u5347\u7EA7\uFF1A\u8D64\u7130\u6838\u5FC3 \u2192 \u7194\u6F6E\u76DF\u6838\uFF0C\u5E76\u52A0\u5165\u6F6E\u536B",
      blurb: "\u53EA\u628A\u708E\u5203\u5251\u58EB\u6362\u6210\u82CD\u6F9C\u6F6E\u536B\uFF1A\u6F6E\u536B\u7ACB\u523B\u89E6\u72AF\u8D64\u7130\u76DF\u4E3B\u7684\u9635\u8425\u76DF\u7EA6\u3002\u540C\u4E00\u6279\u628A\u6838\u5FC3\u6362\u6210\u5141\u8BB8\u82CD\u6F9C\u7684\u7194\u6F6E\u76DF\u6838\u540E\uFF0C\u6574\u6279\u5408\u6CD5\u3002",
      pairs: [
        { id: "pair-p1", mainUid: "aggro-core", sideUid: "aggro-pact" },
        { id: "pair-p2", mainUid: "aggro-blade", sideUid: "aggro-warden" }
      ]
    }
  ];
  function cloneDefaultDecks() {
    return JSON.parse(JSON.stringify(DEFAULT_DECKS));
  }

  // src/deckUtils.ts
  function isEntry(e) {
    return e.kind === "entry";
  }
  function isUnresolved(e) {
    return e.kind === "unresolved";
  }
  function zoneTotal(entries2) {
    return entries2.reduce((s, e) => s + e.count, 0);
  }
  function findEntry(deck2, uid) {
    return [...deck2.main, ...deck2.sideboard].find((e) => e.uid === uid);
  }
  function cardCounts(entries2, pool = CURRENT_POOL) {
    const m = /* @__PURE__ */ new Map();
    for (const e of entries2) {
      if (!isEntry(e)) continue;
      m.set(e.cardId, (m.get(e.cardId) ?? 0) + e.count);
    }
    return m;
  }
  function entryUidsForCard(entries2, cardId) {
    return entries2.filter((e) => isEntry(e) && e.cardId === cardId).map((e) => e.uid);
  }
  var iidSeq = 1;
  function expandZone(deck2, zone, pool = CURRENT_POOL) {
    const out = [];
    for (const e of zone === "main" ? deck2.main : deck2.sideboard) {
      if (!isEntry(e)) continue;
      if (!pool.cardById.has(e.cardId)) continue;
      for (let i = 0; i < e.count; i++) {
        out.push({ iid: iidSeq++, cardId: e.cardId, printingId: e.printingId });
      }
    }
    return out;
  }
  function entryLabel(e, pool = CURRENT_POOL) {
    if (e.kind === "unresolved") return `${e.exportedName}\uFF08\u65B0\u7248\u672C\u7F3A\u5931\uFF1A${e.cardId}\uFF09`;
    const c = pool.cardById.get(e.cardId);
    return c ? c.name : `\u672A\u77E5\u5361 ${e.cardId}`;
  }
  function cloneDeck(d) {
    return JSON.parse(JSON.stringify(d));
  }

  // src/state.ts
  var STORAGE_KEY = "diamond-deck-lab-state-v1";
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.decks) && parsed.decks.length > 0) {
          return { decks: parsed.decks, selectedDeckId: parsed.selectedDeckId ?? parsed.decks[0].id };
        }
      }
    } catch {
    }
    const decks = cloneDefaultDecks();
    return { decks, selectedDeckId: decks[0].id };
  }
  var Store = class {
    constructor() {
      this.listeners = /* @__PURE__ */ new Set();
      const s = load();
      this.decks = s.decks;
      this.selectedDeckId = s.selectedDeckId;
    }
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    emit() {
      this.persist();
      this.listeners.forEach((fn) => fn());
    }
    persist() {
      try {
        const data = { decks: this.decks, selectedDeckId: this.selectedDeckId };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch {
      }
    }
    get selectedDeck() {
      return this.decks.find((d) => d.id === this.selectedDeckId) ?? this.decks[0];
    }
    select(id) {
      this.selectedDeckId = id;
      this.emit();
    }
    /** 在选中牌组的可变克隆上修改并提交 */
    updateSelected(mutator) {
      const idx = this.decks.findIndex((d) => d.id === this.selectedDeckId);
      if (idx < 0) return;
      const copy = cloneDeck(this.decks[idx]);
      mutator(copy);
      this.decks[idx] = copy;
      this.emit();
    }
    replaceDeck(id, next) {
      const idx = this.decks.findIndex((d) => d.id === id);
      if (idx >= 0) this.decks[idx] = next;
      else this.decks.push(next);
      this.selectedDeckId = next.id;
      this.emit();
    }
    addDeck(deck2, select = true) {
      this.decks.push(deck2);
      if (select) this.selectedDeckId = deck2.id;
      this.emit();
    }
    deleteDeck(id) {
      if (this.decks.length <= 1) return;
      const idx = this.decks.findIndex((d) => d.id === id);
      if (idx < 0) return;
      this.decks.splice(idx, 1);
      if (this.selectedDeckId === id) this.selectedDeckId = this.decks[0].id;
      this.emit();
    }
    resetAll() {
      this.decks = cloneDefaultDecks();
      this.selectedDeckId = this.decks[1]?.id ?? this.decks[0].id;
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
      }
      this.emit();
    }
  };
  var store = new Store();

  // src/validate.ts
  function validateDeck(deck2, pool = CURRENT_POOL) {
    const hits = [];
    const push = (h2) => hits.push(h2);
    for (const e of [...deck2.main, ...deck2.sideboard]) {
      if (isUnresolved(e)) {
        const sameName = e.sameNameCandidates.map((id) => pool.cardById.get(id)?.name).filter(Boolean);
        push({
          code: "R-UNRESOLVED",
          severity: "error",
          zone: deck2.main.includes(e) ? "main" : "sideboard",
          entryUids: [e.uid],
          cardId: e.cardId,
          message: `\u300C${e.exportedName}\u300D\u5728\u5F53\u524D\u5361\u6C60 ${pool.version} \u4E2D\u4E0D\u5B58\u5728\uFF08\u5BFC\u51FA id\uFF1A${e.cardId}\uFF09\u3002` + (sameName.length ? `\u53D1\u73B0\u540C\u540D\u65B0\u724C\u300C${sameName.join("\u3001")}\u300D\u4F46 id \u4E0D\u540C\uFF0C\u672A\u81EA\u52A8\u66FF\u6362\uFF1B\u8BF7\u624B\u52A8\u51B3\u5B9A\u6620\u5C04\u6216\u4FDD\u7559\u7F3A\u5931\u3002` : "\u6CA1\u6709\u627E\u5230\u53EF\u6620\u5C04\u7684\u724C\uFF0C\u672A\u6309\u540D\u5B57\u731C\u6D4B\u66FF\u6362\u3002")
        });
        continue;
      }
      const card = pool.cardById.get(e.cardId);
      if (!card) {
        push({
          code: "R-UNRESOLVED",
          severity: "error",
          message: `\u6761\u76EE ${e.cardId} \u65E0\u6CD5\u5728\u5361\u6C60 ${pool.version} \u4E2D\u89E3\u6790\u3002`,
          cardId: e.cardId,
          entryUids: [e.uid]
        });
        continue;
      }
      if (!card.printings.some((p) => p.id === e.printingId)) {
        push({
          code: "R-PRINTING-MISSING",
          severity: "error",
          cardId: card.id,
          printingId: e.printingId,
          entryUids: [e.uid],
          message: `\u300C${card.name}\u300D\u7684\u5370\u6B21 ${e.printingId} \u5728\u5361\u6C60 ${pool.version} \u4E2D\u4E0D\u5B58\u5728\uFF0C\u5370\u6B21\u4E0D\u80FD\u88AB\u9759\u9ED8\u6539\u5199\u3002`
        });
      }
    }
    const mainTotal = zoneTotal(deck2.main);
    if (mainTotal !== RULES.mainSize) {
      push({
        code: "R-DECK-SIZE",
        severity: "error",
        zone: "main",
        message: `\u4E3B\u724C\u5FC5\u987B\u6B63\u597D ${RULES.mainSize} \u5F20\uFF0C\u5F53\u524D ${mainTotal} \u5F20\uFF08\u5DEE ${mainTotal - RULES.mainSize}\uFF09\u3002`
      });
    }
    const sideTotal = zoneTotal(deck2.sideboard);
    if (sideTotal > RULES.sideboardMax) {
      push({
        code: "R-SIDE-SIZE",
        severity: "error",
        zone: "sideboard",
        message: `\u5907\u9009\u724C\u6700\u591A ${RULES.sideboardMax} \u5F20\uFF0C\u5F53\u524D ${sideTotal} \u5F20\u3002`
      });
    }
    for (const zone of ["main", "sideboard"]) {
      const entries2 = zone === "main" ? deck2.main : deck2.sideboard;
      const counts = cardCounts(entries2, pool);
      for (const [cardId, total] of counts) {
        const card = pool.cardById.get(cardId);
        if (!card) continue;
        if (total > card.limit) {
          push({
            code: "R-COPY-LIMIT",
            severity: "error",
            zone,
            cardId,
            entryUids: entryUidsForCard(entries2, cardId),
            message: `${zone === "main" ? "\u4E3B\u724C" : "\u5907\u9009"}\u4E2D\u300C${card.name}\u300D\u5408\u8BA1 ${total} \u5F20\uFF08\u4E0D\u540C\u5370\u6B21\u5171\u4EAB\u4E0A\u9650 ${card.limit}\uFF09\uFF0C\u8D85\u51FA ${total - card.limit} \u5F20\u3002`
          });
        }
      }
    }
    const mainEntries = deck2.main.filter(isEntry);
    const coreEntries = mainEntries.filter((e) => pool.cardById.get(e.cardId)?.type === "core");
    const coreCount = coreEntries.reduce((s, e) => s + e.count, 0);
    if (coreCount < RULES.coreMin) {
      push({
        code: "R-CORE-MIN",
        severity: "error",
        zone: "main",
        message: `\u724C\u7EC4\u81F3\u5C11\u9700\u8981 ${RULES.coreMin} \u679A\u6838\u5FC3\u724C\uFF0C\u5F53\u524D ${coreCount} \u679A\u3002`,
        entryUids: coreEntries.map((e) => e.uid)
      });
    }
    if (coreCount > RULES.coreMax) {
      push({
        code: "R-CORE-MAX",
        severity: "error",
        zone: "main",
        message: `\u6838\u5FC3\u724C\u6700\u591A ${RULES.coreMax} \u679A\uFF0C\u5F53\u524D ${coreCount} \u679A\u3002`,
        entryUids: coreEntries.map((e) => e.uid)
      });
    }
    for (const coreEntry of coreEntries) {
      const core = pool.cardById.get(coreEntry.cardId);
      if (!core?.core) continue;
      const allied = new Set(core.core.allied);
      const badByCard = /* @__PURE__ */ new Map();
      for (const e of mainEntries) {
        if (e.uid === coreEntry.uid && e.cardId === core.id) continue;
        const c = pool.cardById.get(e.cardId);
        if (!c || c.faction === "neutral") continue;
        if (!allied.has(c.faction)) {
          badByCard.set(c.id, (badByCard.get(c.id) ?? 0) + e.count);
        }
      }
      for (const [badCardId, n] of badByCard) {
        const bad = pool.cardById.get(badCardId);
        push({
          code: "R-CORE-FACTION",
          severity: "error",
          zone: "main",
          coreCardId: core.id,
          cardId: badCardId,
          entryUids: entryUidsForCard(deck2.main, badCardId),
          message: `\u6838\u5FC3\u300C${core.name}\u300D\u7684\u76DF\u7EA6\u53EA\u5141\u8BB8 ${core.core.allied.map((f) => pool && FACTION_NAME[f]).join(" / ")} \u540C\u961F\uFF1B\u300C${bad?.name ?? badCardId}\u300D\xD7${n} \u4E0D\u5728\u5141\u8BB8\u9635\u8425\u5185\u3002`
        });
      }
    }
    const errors = hits.filter((h2) => h2.severity === "error");
    const warnings = hits.filter((h2) => h2.severity === "warning");
    return { legal: errors.length === 0, errors, warnings, hits };
  }
  var FACTION_NAME = {
    crimson: "\u8D64\u7130",
    tide: "\u82CD\u6F9C",
    grove: "\u68EE\u7F57",
    neutral: "\u4E2D\u7ACB"
  };

  // src/ui/common.ts
  function factionTag(factionId, opts) {
    const f = FACTIONS[factionId];
    return h(
      "span",
      {
        class: "faction-tag",
        style: opts?.soft ? `color:${f.color};background:${f.soft}` : `color:#fff;background:${f.color}`,
        title: `\u9635\u8425\uFF1A${f.name}`
      },
      f.name
    );
  }
  function costBadge(cost) {
    if (cost == null) return h("span", { class: "cost-badge cost-core", title: "\u6838\u5FC3\u724C" }, "\u6838");
    return h("span", { class: "cost-badge", title: `\u8D39\u7528 ${cost}` }, String(cost));
  }
  function cardTitle(cardId, pool = CURRENT_POOL) {
    const c = pool.cardById.get(cardId);
    if (!c) {
      return h("span", { class: "card-title is-missing" }, h("span", { class: "diamond" }, "\u2666"), cardId);
    }
    const f = FACTIONS[c.faction];
    return h(
      "span",
      { class: "card-title", title: c.text },
      h("span", { class: "diamond", style: `color:${f.color}` }, "\u2666"),
      h("span", { class: "card-name-text" }, c.name)
    );
  }
  function printingName(cardId, printingId, pool = CURRENT_POOL) {
    const c = pool.cardById.get(cardId);
    const p = c?.printings.find((x) => x.id === printingId);
    return p ? `${p.label} \xB7 ${p.set}` : printingId ? `\u672A\u77E5\u5370\u6B21 ${printingId}` : "\u9ED8\u8BA4\u5370\u6B21";
  }
  function cardLine(opts) {
    const pool = opts.pool ?? CURRENT_POOL;
    const c = pool.cardById.get(opts.cardId);
    if (!c) {
      return h(
        "div",
        { class: `card-line is-missing${opts.muted ? " is-muted" : ""}` },
        h("span", { class: "diamond" }, "\u2666"),
        h("span", { class: "card-name-text" }, `\u7F3A\u5931\u724C ${opts.cardId}`),
        opts.count != null ? h("span", { class: "qty" }, `\xD7${opts.count}`) : null,
        opts.extra ?? null
      );
    }
    return h(
      "div",
      { class: `card-line${opts.muted ? " is-muted" : ""}` },
      costBadge(c.cost),
      cardTitle(c.id, pool),
      factionTag(c.faction, { soft: true }),
      h("span", { class: "printing-pill", title: "\u5370\u6B21" }, printingName(c.id, opts.printingId, pool)),
      opts.badges ?? null,
      opts.count != null ? h("span", { class: "qty" }, `\xD7${opts.count}`) : null,
      opts.extra ?? null
    );
  }
  function entryLine(entry, pool = CURRENT_POOL, extra, opts) {
    const count2 = opts?.hideCount ? void 0 : entry.count;
    if (entry.kind === "unresolved") {
      return h(
        "div",
        { class: "card-line is-unresolved" },
        h("span", { class: "diamond" }, "\u2666"),
        h("span", { class: "card-name-text" }, entry.exportedName),
        h("span", { class: "tag tag-danger" }, "\u65B0\u7248\u672C\u7F3A\u5931"),
        h("span", { class: "printing-pill" }, entry.exportedPrintingLabel ?? entry.printingId ?? "\u5370\u6B21\u672A\u77E5"),
        h("span", { class: "mono tiny muted" }, entry.cardId),
        count2 != null ? h("span", { class: "qty" }, `\xD7${count2}`) : null,
        extra ?? null
      );
    }
    return cardLine({ cardId: entry.cardId, printingId: entry.printingId, count: count2, pool, extra });
  }
  function hitItem(hit) {
    const cls = hit.severity === "error" ? "hit-error" : hit.severity === "warning" ? "hit-warn" : "hit-info";
    const icon = hit.severity === "error" ? "\u2715" : hit.severity === "warning" ? "!" : "i";
    return h("li", { class: `hit ${cls}` }, h("span", { class: "hit-icon" }, icon), h("span", null, hit.message));
  }
  function hitList(hits, emptyText) {
    if (hits.length === 0) {
      return h("div", { class: "ok-banner" }, "\u2713 ", emptyText ?? "\u6CA1\u6709\u89E6\u53D1\u89C4\u5219\u95EE\u9898");
    }
    return h("ul", { class: "hit-list" }, ...hits.map(hitItem));
  }
  function deckValidity(deck2) {
    const r = validateDeck(deck2);
    return { legal: r.legal, errorCount: r.errors.length };
  }
  function deckPicker(selectedId, onSelect, decks) {
    return h(
      "label",
      { class: "deck-picker" },
      h("span", { class: "picker-label" }, "\u5F53\u524D\u724C\u7EC4"),
      (() => {
        const sel = h(
          "select",
          {
            onchange: (e) => onSelect(e.target.value)
          },
          ...decks.map((d) => {
            const v = deckValidity(d);
            return h(
              "option",
              { value: d.id, selected: d.id === selectedId },
              `${v.legal ? "\u2713" : "\u2715"} ${d.name}`
            );
          })
        );
        sel.value = selectedId;
        return sel;
      })()
    );
  }
  function sectionTitle(title, sub, right) {
    return h(
      "div",
      { class: "section-title-row" },
      h("div", null, h("h2", { class: "section-title" }, title), sub ? h("p", { class: "section-sub" }, sub) : null),
      right ? h("div", { class: "section-right" }, right) : null
    );
  }

  // src/ui/tab-decks.ts
  function printingSelect(entry) {
    const card = CURRENT_POOL.cardById.get(entry.cardId);
    if (!card) return null;
    return h(
      "select",
      {
        class: "printing-select",
        title: "\u9009\u62E9\u5370\u6B21\uFF08\u4E0D\u540C\u5370\u6B21\u5171\u4EAB\u6570\u91CF\u4E0A\u9650\uFF09",
        onchange: (e) => {
          const v = e.target.value;
          store.updateSelected((d) => {
            const target = [...d.main, ...d.sideboard].find((x) => x.uid === entry.uid);
            if (target && target.kind === "entry") target.printingId = v;
          });
        }
      },
      ...card.printings.map(
        (p) => h("option", { value: p.id, selected: p.id === entry.printingId }, `${p.label} \xB7 ${p.set}${p.foil ? " \u2726\u95EA" : ""}`)
      )
    );
  }
  function countControls(entry) {
    return h(
      "span",
      { class: "count-controls" },
      h("button", {
        class: "mini-btn",
        title: "\u51CF\u5C11\u4E00\u5F20",
        onclick: () => store.updateSelected((d) => {
          const t = [...d.main, ...d.sideboard].find((x) => x.uid === entry.uid);
          if (t) t.count = Math.max(0, t.count - 1);
          if (t && t.count === 0) removeEntry(d, entry.uid);
        })
      }, "\u2212"),
      h("span", { class: "count-num" }, String(entry.count)),
      h("button", {
        class: "mini-btn",
        title: "\u589E\u52A0\u4E00\u5F20",
        onclick: () => store.updateSelected((d) => {
          const t = [...d.main, ...d.sideboard].find((x) => x.uid === entry.uid);
          if (t) t.count += 1;
        })
      }, "+")
    );
  }
  function removeEntry(d, uid) {
    d.main = d.main.filter((e) => e.uid !== uid);
    d.sideboard = d.sideboard.filter((e) => e.uid !== uid);
  }
  function entryRow(entry) {
    const controls = h(
      "span",
      { class: "row-controls" },
      entry.kind === "entry" ? printingSelect(entry) : null,
      countControls(entry),
      h(
        "button",
        {
          class: "mini-btn mini-danger",
          title: "\u5220\u9664\u6574\u6761",
          onclick: () => store.updateSelected((d) => {
            d.main = d.main.filter((x) => x.uid !== entry.uid);
            d.sideboard = d.sideboard.filter((x) => x.uid !== entry.uid);
          })
        },
        "\u5220"
      )
    );
    return h("div", { class: "entry-row" }, entryLine(entry, CURRENT_POOL, controls, { hideCount: true }));
  }
  function addCardBar(zone) {
    const select = h(
      "select",
      { class: "add-card-select" },
      h("option", { value: "" }, `\uFF0B \u9009\u62E9\u5361\u724C\u52A0\u5165${zone === "main" ? "\u4E3B\u724C" : "\u5907\u9009"}\u2026`),
      ...FACTION_ORDER.flatMap((f) => {
        const cards = CURRENT_POOL.cards.filter((c) => c.faction === f);
        return [
          h("optgroup", { label: FACTIONS[f].name }, ...cards.map((c) => h("option", { value: c.id }, `\u2666 ${c.name}\uFF08\u4E0A\u9650 ${c.limit}\uFF09`)))
        ];
      })
    );
    return h(
      "div",
      { class: "add-card-bar" },
      select,
      h("button", {
        class: "btn btn-small",
        onclick: () => {
          const cardId = select.value;
          if (!cardId) return;
          const card = CURRENT_POOL.cardById.get(cardId);
          store.updateSelected((d) => {
            const list = zone === "main" ? d.main : d.sideboard;
            const existing = list.find((e) => e.kind === "entry" && e.cardId === cardId && e.printingId === card.printings[0].id);
            if (existing) existing.count += 1;
            else
              list.push({
                kind: "entry",
                uid: genUid("add"),
                cardId,
                printingId: card.printings[0].id,
                count: 1
              });
          });
          select.value = "";
        }
      }, "\u52A0\u5165\u4E00\u5F20")
    );
  }
  function factionDistribution(deck2) {
    const counts = { crimson: 0, tide: 0, grove: 0, neutral: 0 };
    for (const e of deck2.main) {
      if (e.kind !== "entry") continue;
      const c = CURRENT_POOL.cardById.get(e.cardId);
      if (c) counts[c.faction] += e.count;
    }
    const total = zoneTotal(deck2.main) || 1;
    return h(
      "div",
      { class: "faction-dist" },
      h("div", { class: "dist-bar" }, ...FACTION_ORDER.map(
        (f) => counts[f] > 0 ? h("div", {
          class: "dist-seg",
          style: `width:${counts[f] / total * 100}%;background:${FACTIONS[f].color}`,
          title: `${FACTIONS[f].name} ${counts[f]}`
        }) : null
      )),
      h(
        "div",
        { class: "dist-legend" },
        ...FACTION_ORDER.map(
          (f) => h("span", { class: "legend-item" }, h("i", { style: `background:${FACTIONS[f].color}` }), `${FACTIONS[f].name} ${counts[f]}`)
        )
      )
    );
  }
  function renderDecksTab() {
    const deck2 = store.selectedDeck;
    const report = validateDeck(deck2);
    const mainTotal = zoneTotal(deck2.main);
    const sideTotal = zoneTotal(deck2.sideboard);
    const list = h(
      "div",
      { class: "deck-list" },
      ...store.decks.map((d) => {
        const v = deckValidity(d);
        return h(
          "button",
          {
            class: `deck-list-item${d.id === deck2.id ? " active" : ""}`,
            onclick: () => store.select(d.id)
          },
          h("span", { class: `valid-dot ${v.legal ? "is-legal" : "is-illegal"}`, title: v.legal ? "\u89C4\u5219\u5408\u6CD5" : `${v.errorCount} \u4E2A\u89C4\u5219\u9519\u8BEF` }),
          h("span", { class: "deck-list-name" }, d.name),
          h("span", { class: "deck-list-tag" }, d.tag)
        );
      })
    );
    const editor = h(
      "div",
      { class: "deck-editor" },
      h(
        "div",
        { class: "deck-head card-panel" },
        h("input", {
          class: "deck-name-input",
          value: deck2.name,
          onchange: (e) => store.updateSelected((d) => {
            d.name = e.target.value || d.name;
          })
        }),
        h("div", { class: "deck-tag-row" }, h("span", { class: "tag" }, deck2.tag), h("span", { class: "muted small" }, deck2.id)),
        h("textarea", {
          class: "deck-desc-input",
          rows: 2,
          onchange: (e) => store.updateSelected((d) => {
            d.description = e.target.value;
          })
        }, deck2.description),
        deck2.pitfall ? h("div", { class: "pitfall-callout" }, h("strong", null, "\u6545\u610F\u5361\u4F4F\u7684\u70B9\uFF1A"), deck2.pitfall) : null,
        h(
          "div",
          { class: "deck-head-actions" },
          h("button", {
            class: "btn btn-small btn-danger-ghost",
            onclick: () => {
              if (confirm(`\u5220\u9664\u724C\u7EC4\u300C${deck2.name}\u300D\uFF1F\u53EF\u901A\u8FC7\u300C\u6062\u590D\u5168\u90E8\u9ED8\u8BA4\u724C\u7EC4\u300D\u627E\u56DE\u5185\u7F6E\u724C\u7EC4\u3002`)) store.deleteDeck(deck2.id);
            }
          }, "\u5220\u9664\u6B64\u724C\u7EC4"),
          h("button", { class: "btn btn-small", onclick: () => store.resetAll() }, "\u6062\u590D\u5168\u90E8\u9ED8\u8BA4\u724C\u7EC4")
        )
      ),
      h(
        "div",
        { class: `validation-panel card-panel ${report.legal ? "is-legal" : "is-illegal"}` },
        h(
          "div",
          { class: "validation-head" },
          h("span", { class: `verdict-badge ${report.legal ? "verdict-ok" : "verdict-bad"}` }, report.legal ? "\u6574\u7EC4\u5408\u6CD5" : `\u5B58\u5728 ${report.errors.length} \u4E2A\u9519\u8BEF`),
          h("span", { class: "muted small" }, "\u89C4\u5219\uFF1A\u4E3B\u724C 40 \u5F20 \xB7 \u5907\u9009 \u226410 \xB7 \u540C\u5361\u8DE8\u5370\u6B21\u5171\u4EAB\u4E0A\u9650\uFF08\u4E3B/\u5907\u5206\u522B\u7ED3\u7B97\uFF09 \xB7 \u6838\u5FC3 1\u20132 \u679A\u4E14\u9635\u8425\u76DF\u7EA6\u987B\u540C\u65F6\u6EE1\u8DB3")
        ),
        hitList(report.hits)
      ),
      h(
        "div",
        { class: "deck-zones" },
        h(
          "section",
          { class: "zone card-panel" },
          sectionTitle(`\u4E3B\u724C\uFF08${mainTotal}/${RULES.mainSize}\uFF09`, "\u8D77\u624B\u62BD\u724C\u53EA\u5C55\u5F00\u4E3B\u724C"),
          factionDistribution(deck2),
          h("div", { class: "entry-list" }, ...deck2.main.map(entryRow)),
          addCardBar("main")
        ),
        h(
          "section",
          { class: "zone card-panel" },
          sectionTitle(`\u5907\u9009\uFF08${sideTotal}/${RULES.sideboardMax}\uFF09`, "\u8D5B\u524D\u53EF\u4E0E\u4E3B\u724C 1:1 \u4E92\u6362"),
          h("div", { class: "entry-list" }, ...deck2.sideboard.map(entryRow)),
          addCardBar("sideboard")
        )
      )
    );
    return h("div", { class: "tab-decks layout-sidebar" }, h("aside", { class: "sidebar card-panel" }, h("h2", { class: "sidebar-title" }, "\u672C\u5730\u724C\u7EC4"), list), editor);
  }

  // src/exchange.ts
  function entryDisplayName(e, pool) {
    if (e.kind === "unresolved") return e.exportedName;
    return pool.cardById.get(e.cardId)?.name ?? e.cardId;
  }
  function checkQty(deck2, pairs, pool) {
    const hits = [];
    const mainQty = /* @__PURE__ */ new Map();
    const sideQty = /* @__PURE__ */ new Map();
    for (const p of pairs) {
      mainQty.set(p.mainUid, (mainQty.get(p.mainUid) ?? 0) + 1);
      sideQty.set(p.sideUid, (sideQty.get(p.sideUid) ?? 0) + 1);
    }
    for (const [uid, q] of mainQty) {
      const e = deck2.main.find((x) => x.uid === uid);
      if (!e) {
        hits.push({ code: "R-ACTION-QTY", severity: "error", message: `\u4E3B\u724C\u6761\u76EE ${uid} \u5DF2\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u79FB\u51FA\u3002`, entryUids: [uid] });
      } else if (q > e.count) {
        hits.push({
          code: "R-ACTION-QTY",
          severity: "error",
          zone: "main",
          entryUids: [uid],
          cardId: isEntry(e) ? e.cardId : e.cardId,
          message: `\u8BA1\u5212\u4ECE\u300C${entryDisplayName(e, pool)}\u300D\u79FB\u51FA ${q} \u5F20\uFF0C\u4F46\u8BE5\u6761\u76EE\u53EA\u6709 ${e.count} \u5F20\u3002`
        });
      }
    }
    for (const [uid, q] of sideQty) {
      const e = deck2.sideboard.find((x) => x.uid === uid);
      if (!e) {
        hits.push({ code: "R-ACTION-QTY", severity: "error", message: `\u5907\u9009\u6761\u76EE ${uid} \u5DF2\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u6362\u5165\u3002`, entryUids: [uid] });
      } else if (q > e.count) {
        hits.push({
          code: "R-ACTION-QTY",
          severity: "error",
          zone: "sideboard",
          entryUids: [uid],
          cardId: isEntry(e) ? e.cardId : e.cardId,
          message: `\u8BA1\u5212\u6362\u5165\u300C${entryDisplayName(e, pool)}\u300D${q} \u5F20\uFF0C\u4F46\u5907\u9009\u53EA\u6709 ${e.count} \u5F20\u3002`
        });
      }
    }
    return hits;
  }
  function drain(entries2, uid, qty) {
    const idx = entries2.findIndex((e2) => e2.uid === uid);
    if (idx < 0) return null;
    const e = entries2[idx];
    if (e.kind !== "entry") return { cardId: e.cardId, printingId: e.printingId ?? "missing", qty };
    const snap = { cardId: e.cardId, printingId: e.printingId, qty };
    e.count -= qty;
    if (e.count <= 0) entries2.splice(idx, 1);
    return snap;
  }
  function addCopy(entries2, snap) {
    const existing = entries2.find(
      (e) => e.kind === "entry" && e.cardId === snap.cardId && e.printingId === snap.printingId
    );
    if (existing) {
      existing.count += snap.qty;
    } else {
      entries2.push({ kind: "entry", uid: genUid("moved"), cardId: snap.cardId, printingId: snap.printingId, count: snap.qty });
    }
  }
  function applyBatch(deck2, pairs, pool = CURRENT_POOL) {
    const qtyHits = checkQty(deck2, pairs, pool);
    if (qtyHits.length > 0) {
      return { final: null, qtyHits, report: null, legal: false };
    }
    const final = cloneDeck(deck2);
    const mainDrain = /* @__PURE__ */ new Map();
    const sideDrain = /* @__PURE__ */ new Map();
    for (const p of pairs) {
      mainDrain.set(p.mainUid, (mainDrain.get(p.mainUid) ?? 0) + 1);
      sideDrain.set(p.sideUid, (sideDrain.get(p.sideUid) ?? 0) + 1);
    }
    const mainOut = [];
    const sideOut = [];
    for (const [uid, q] of mainDrain) {
      const s = drain(final.main, uid, q);
      if (s) mainOut.push(s);
    }
    for (const [uid, q] of sideDrain) {
      const s = drain(final.sideboard, uid, q);
      if (s) sideOut.push(s);
    }
    for (const s of mainOut) addCopy(final.sideboard, s);
    for (const s of sideOut) addCopy(final.main, s);
    const report = validateDeck(final, pool);
    return { final, qtyHits: [], report, legal: report.legal };
  }
  function capLine(deck2, cardId, zone, delta, pool) {
    const card = pool.cardById.get(cardId);
    const limit = card?.limit ?? 4;
    const n = (zone === "main" ? deck2.main : deck2.sideboard).filter((e) => isEntry(e) && e.cardId === cardId).reduce((s, e) => s + e.count, 0);
    const after = n + delta;
    const mark = after > limit ? " \u26A0 \u8D85\u9650" : after === limit ? "\uFF08\u5DF2\u6EE1\uFF09" : "";
    return `${zone === "main" ? "\u4E3B\u724C" : "\u5907\u9009"}\u540C\u540D\u5408\u8BA1 ${n} \u2192 ${after}\uFF0C\u4E0A\u9650 ${limit}${mark}`;
  }
  function analyzePair(deck2, pair, pool = CURRENT_POOL) {
    const outEntry = findEntry(deck2, pair.mainUid);
    const inEntry = findEntry(deck2, pair.sideUid);
    const outCardId = outEntry && isEntry(outEntry) ? outEntry.cardId : void 0;
    const inCardId = inEntry && isEntry(inEntry) ? inEntry.cardId : void 0;
    const outCard = outCardId ? pool.cardById.get(outCardId) : void 0;
    const inCard = inCardId ? pool.cardById.get(inCardId) : void 0;
    const applied = applyBatch(deck2, [pair], pool);
    const singleReport = applied.report ?? {
      legal: false,
      errors: applied.qtyHits,
      warnings: [],
      hits: applied.qtyHits
    };
    const outEffects = [];
    const inEffects = [];
    if (outCardId) {
      outEffects.push(capLine(deck2, outCardId, "main", -1, pool));
      if (outCard?.type === "core") {
        const coreCount = deck2.main.filter((e) => isEntry(e) && pool.cardById.get(e.cardId)?.type === "core").reduce((s, e) => s + e.count, 0);
        if (coreCount <= 1 && inCard?.type !== "core") {
          outEffects.push(`\u8FD9\u662F\u552F\u4E00\u6838\u5FC3\uFF0C\u4E14\u6362\u5165\u7684\u4E0D\u662F\u6838\u5FC3\uFF1A\u79FB\u8D70\u540E\u5C06\u4E0D\u6EE1\u8DB3\u6838\u5FC3\u6570\u91CF \u22651\uFF08R-CORE-MIN\uFF09`);
        } else if (inCard?.type === "core") {
          outEffects.push(`\u79FB\u8D70\u6B64\u6838\u5FC3\u540E\u7531\u6362\u5165\u7684\u300C${inCard.name}\u300D\u63A5\u4EFB\u6838\u5FC3\u4F4D\uFF0C\u6838\u5FC3\u6570\u91CF\u4E0D\u53D8`);
        } else {
          outEffects.push(`\u79FB\u8D70\u6838\u5FC3\u540E\uFF0C\u5B83\u7684\u9635\u8425\u76DF\u7EA6\u968F\u4E4B\u89E3\u9664`);
        }
      }
    }
    if (inCardId) {
      inEffects.push(capLine(deck2, inCardId, "main", 1, pool));
      if (inCard?.type === "core" && inCard.core) {
        inEffects.push(`\u65B0\u6838\u5FC3\u76DF\u7EA6\u5141\u8BB8\uFF1A${inCard.core.allied.map((f) => FACTION_LABEL[f]).join(" / ")}`);
      }
    }
    const outHits = [];
    const inHits = [];
    for (const hit of singleReport.hits) {
      const side = attributeHit(hit, outCardId, inCardId);
      if (side === "out") outHits.push(hit);
      else if (side === "in") inHits.push(hit);
    }
    return {
      pair,
      singleLegal: singleReport.legal,
      singleReport,
      out: {
        uid: pair.mainUid,
        cardId: outCardId,
        title: outCard ? `\u539F\u724C\uFF1A\u2666 ${outCard.name}` : `\u539F\u724C\uFF1A${outEntry && !isEntry(outEntry) ? outEntry.exportedName : pair.mainUid}`,
        hits: outHits,
        effects: outEffects
      },
      incoming: {
        uid: pair.sideUid,
        cardId: inCardId,
        title: inCard ? `\u6362\u5165\uFF1A\u2666 ${inCard.name}` : `\u6362\u5165\uFF1A${inEntry && !isEntry(inEntry) ? inEntry.exportedName : pair.sideUid}`,
        hits: inHits,
        effects: inEffects
      }
    };
  }
  var FACTION_LABEL = { crimson: "\u8D64\u7130", tide: "\u82CD\u6F9C", grove: "\u68EE\u7F57", neutral: "\u4E2D\u7ACB" };
  function attributeHit(hit, outCardId, inCardId) {
    if (inCardId && (hit.cardId === inCardId || hit.coreCardId === inCardId)) return "in";
    if (outCardId && (hit.cardId === outCardId || hit.coreCardId === outCardId)) return "out";
    if (hit.code === "R-CORE-MIN") return "out";
    if (hit.code === "R-DECK-SIZE" && /当前 \d+ 张（差 -?\d+）/.test(hit.message) && hit.message.includes("\u5DEE -")) return "in";
    if (hit.code === "R-DECK-SIZE") return "out";
    return null;
  }

  // src/ui/tab-exchange.ts
  var draftDeckId = null;
  var draft = [];
  var appliedNote = null;
  var draftSeq = 0;
  function newDraft(mainUid = "", sideUid = "") {
    draftSeq += 1;
    return { id: `draft-${draftSeq}`, mainUid, sideUid };
  }
  function ensureDraft(deckId) {
    if (draftDeckId === deckId) return;
    draftDeckId = deckId;
    appliedNote = null;
    const preset = PRESET_PLANS.find((p) => p.deckId === deckId);
    draft = preset ? preset.pairs.map((p) => newDraft(p.mainUid, p.sideUid)) : [newDraft()];
  }
  function entryOptionText(deck2, uid) {
    const e = [...deck2.main, ...deck2.sideboard].find((x) => x.uid === uid);
    return e ? entryLabel(e, CURRENT_POOL) : uid;
  }
  function uidSelect(zone, value, onChange) {
    const deck2 = store.selectedDeck;
    const entries2 = zone === "main" ? deck2.main : deck2.sideboard;
    const sel = h(
      "select",
      {
        class: "uid-select",
        onchange: (e) => onChange(e.target.value)
      },
      h("option", { value: "" }, zone === "main" ? "\u9009\u62E9\u8981\u79FB\u51FA\u7684\u4E3B\u724C\u2026" : "\u9009\u62E9\u8981\u6362\u5165\u7684\u5907\u9009\u724C\u2026"),
      ...entries2.map((e) => h("option", { value: e.uid, selected: e.uid === value }, `\xD7${e.count}  ${entryLabel(e, CURRENT_POOL)}`))
    );
    sel.value = value;
    return sel;
  }
  function sideAnalysisBox(title, a, tone) {
    return h(
      "div",
      { class: `attr-box attr-${tone}${a.hits.length ? " has-hit" : ""}` },
      h("div", { class: "attr-title" }, title),
      h("div", { class: "attr-card" }, a.title),
      a.effects.length ? h("ul", { class: "effect-list" }, ...a.effects.map((x) => h("li", null, x))) : null,
      a.hits.length ? hitList(a.hits) : h("div", { class: "attr-ok" }, "\u672A\u76F4\u63A5\u89E6\u53D1\u8FDD\u89C4\u89C4\u5219")
    );
  }
  function pairCard(analysis, index, rerender) {
    return h(
      "div",
      { class: `pair-card card-panel ${analysis.singleLegal ? "pair-ok" : "pair-bad"}` },
      h(
        "div",
        { class: "pair-card-head" },
        h("span", { class: "pair-label" }, `\u7B2C ${index + 1} \u5BF9`),
        h(
          "span",
          { class: `verdict-badge ${analysis.singleLegal ? "verdict-ok" : "verdict-bad"}` },
          analysis.singleLegal ? "\u53EA\u6362\u8FD9\u4E00\u5BF9\uFF1A\u5408\u6CD5" : "\u53EA\u6362\u8FD9\u4E00\u5BF9\uFF1A\u4E0D\u5408\u6CD5"
        ),
        h("span", { class: "spacer" }),
        h("button", {
          class: "mini-btn mini-danger",
          onclick: () => {
            draft = draft.filter((d) => d.id !== analysis.pair.id);
            rerender();
          }
        }, "\u79FB\u9664\u8FD9\u5BF9")
      ),
      h("div", { class: "attr-grid" }, sideAnalysisBox("\u539F\u724C\uFF08\u4ECE\u4E3B\u724C\u79FB\u51FA\uFF09", analysis.out, "out"), sideAnalysisBox("\u6362\u5165\u724C\uFF08\u4ECE\u5907\u9009\u4E2D\u8FDB\u5165\u4E3B\u724C\uFF09", analysis.incoming, "in")),
      analysis.singleLegal ? null : h("div", { class: "pair-single-all" }, h("strong", null, "\u5355\u72EC\u6267\u884C\u65F6\u7684\u5168\u90E8\u89C4\u5219\u8F93\u51FA\uFF1A"), hitList(analysis.singleReport.hits))
    );
  }
  function presetCard(planId, rerender) {
    const plan = PRESET_PLANS.find((p) => p.id === planId);
    const deck2 = store.decks.find((d) => d.id === plan.deckId);
    if (!deck2) return null;
    const pairAnalyses = plan.pairs.map((p) => analyzePair(deck2, p, CURRENT_POOL));
    const batch = applyBatch(deck2, plan.pairs, CURRENT_POOL);
    return h(
      "div",
      { class: `preset-card ${batch.legal ? "preset-legal" : "preset-illegal"}` },
      h("div", { class: "preset-name" }, plan.name),
      h("p", { class: "preset-blurb" }, plan.blurb),
      h(
        "ul",
        { class: "preset-singles" },
        ...pairAnalyses.map(
          (a, i) => h(
            "li",
            null,
            h("span", { class: `dot ${a.singleLegal ? "dot-ok" : "dot-bad"}` }),
            h("span", null, `\u5355\u6362 ${i + 1}\uFF1A${entryOptionText(deck2, a.pair.mainUid)} \u2192 ${entryOptionText(deck2, a.pair.sideUid)} \u2014 `),
            h("strong", { class: a.singleLegal ? "text-ok" : "text-bad" }, a.singleLegal ? "\u5408\u6CD5" : `\u4E0D\u5408\u6CD5\uFF08${a.incoming.hits[0]?.code ?? a.out.hits[0]?.code ?? "\u89C4\u5219\u9519\u8BEF"}\uFF09`)
          )
        )
      ),
      h(
        "div",
        { class: "preset-batch" },
        "\u6574\u6279\u4E00\u8D77\uFF1A",
        h("strong", { class: batch.legal ? "text-ok" : "text-bad" }, batch.legal ? "\u5408\u6CD5 \u2713 \u53EF\u4EE5\u4E00\u6B21\u751F\u6548" : "\u4ECD\u4E0D\u5408\u6CD5 \u2715")
      ),
      h(
        "div",
        { class: "preset-actions" },
        h("button", {
          class: "btn btn-small",
          onclick: () => {
            draftDeckId = deck2.id;
            draft = plan.pairs.map((p) => newDraft(p.mainUid, p.sideUid));
            store.select(deck2.id);
            rerender();
          }
        }, "\u8F7D\u5165\u5230\u5DE5\u4F5C\u53F0"),
        batch.legal && batch.final ? h("button", {
          class: "btn btn-small btn-primary",
          onclick: () => {
            const res = applyBatch(deck2, plan.pairs, CURRENT_POOL);
            if (!res.legal || !res.final) return;
            store.replaceDeck(deck2.id, res.final);
            draft = [newDraft()];
            appliedNote = `\u5DF2\u6574\u6279\u5E94\u7528\u300C${plan.name}\u300D\uFF1A\u6240\u6709\u79FB\u52A8\u4F5C\u4E3A\u540C\u4E00\u4E8B\u52A1\u751F\u6548\u3002`;
            rerender();
          }
        }, "\u76F4\u63A5\u6574\u6279\u5E94\u7528") : null
      )
    );
  }
  function createExchangeTab() {
    const el = h("div", { class: "tab-exchange" });
    function update() {
      clear(el);
      const deck2 = store.selectedDeck;
      ensureDraft(deck2.id);
      const validPairs = draft.filter((d) => d.mainUid && d.sideUid).map((d) => ({ id: d.id, mainUid: d.mainUid, sideUid: d.sideUid }));
      const analyses = validPairs.map((p) => analyzePair(deck2, p, CURRENT_POOL));
      const batch = validPairs.length ? applyBatch(deck2, validPairs, CURRENT_POOL) : null;
      const deckPlans = PRESET_PLANS.filter((p) => p.deckId === deck2.id);
      const pickerRow = h("div", { class: "tab-toolbar card-panel" }, deckPicker(deck2.id, (id) => store.select(id), store.decks));
      const intro = h(
        "div",
        { class: "explain card-panel" },
        h("strong", null, "\u6574\u6279\u4EA4\u6362\u89C4\u5219\uFF1A"),
        " \u4E00\u6279\u5907\u9009\u4E92\u6362\u8981\u4E48\u5168\u90E8\u751F\u6548\uFF0C\u8981\u4E48\u5168\u90E8\u4E0D\u751F\u6548\u3002\u4E0B\u65B9\u6BCF\u4E00\u5BF9\u90FD\u4F1A\u5355\u72EC\u8BD5\u7B97\uFF08\u770B\u539F\u724C\u4E0E\u6362\u5165\u724C\u5404\u81EA\u89E6\u4E86\u4EC0\u4E48\u89C4\u5219\uFF09\uFF0C\u540C\u65F6\u6309\u300C\u6574\u6279\u7ED3\u7B97\u540E\u7684\u6700\u7EC8\u724C\u7EC4\u300D\u518D\u6821\u9A8C\u4E00\u6B21\u3002\u53EA\u6709\u6574\u6279\u5408\u6CD5\u65F6\uFF0C\u5E94\u7528\u6309\u94AE\u624D\u53EF\u70B9\u3002"
      );
      const note = appliedNote ? h("div", { class: "ok-banner" }, appliedNote) : null;
      const presets = h(
        "section",
        { class: "card-panel" },
        h("h2", { class: "section-title" }, "\u9884\u7F6E\u4EA4\u6362\u96BE\u9898\uFF08\u542B\u300C\u5355\u5F20\u4E0D\u884C\u3001\u6574\u6279\u5408\u6CD5\u300D\uFF09"),
        h("div", { class: "preset-grid" }, ...PRESET_PLANS.map((p) => presetCard(p.id, update))),
        deckPlans.length === 0 ? h("p", { class: "muted small" }, "\u5F53\u524D\u724C\u7EC4\u6CA1\u6709\u4E13\u5C5E\u9884\u7F6E\u65B9\u6848\uFF0C\u53EF\u5728\u4E0B\u65B9\u81EA\u884C\u7EC4\u4E00\u6279\u4EA4\u6362\u3002") : null
      );
      const draftRows = draft.map(
        (d, idx) => h(
          "div",
          { class: "draft-row" },
          h("span", { class: "pair-index" }, `${idx + 1}`),
          uidSelect("main", d.mainUid, (uid) => {
            d.mainUid = uid;
            update();
          }),
          h("span", { class: "swap-arrow" }, "\u21C4"),
          uidSelect("sideboard", d.sideUid, (uid) => {
            d.sideUid = uid;
            update();
          }),
          h("button", {
            class: "mini-btn mini-danger",
            title: "\u79FB\u9664\u8FD9\u4E00\u884C",
            onclick: () => {
              draft = draft.filter((x) => x.id !== d.id);
              update();
            }
          }, "\u2715")
        )
      );
      const editor = h(
        "section",
        { class: "card-panel" },
        h("h2", { class: "section-title" }, "\u4EA4\u6362\u6279\u6B21\u5DE5\u4F5C\u53F0"),
        h("div", { class: "draft-rows" }, draftRows),
        h("button", { class: "btn btn-small", onclick: () => {
          draft.push(newDraft());
          update();
        } }, "\uFF0B \u6DFB\u52A0\u4E00\u5BF9\u4E92\u6362")
      );
      const batchPanel = h(
        "section",
        { class: `card-panel batch-panel ${batch?.legal ? "is-legal" : batch ? "is-illegal" : ""}` },
        h("h2", { class: "section-title" }, "\u6574\u6279\u6821\u9A8C\u4E0E\u751F\u6548"),
        batch ? [
          batch.qtyHits.length ? hitList(batch.qtyHits) : null,
          batch.report ? hitList(batch.report.hits, "\u6574\u6279\u4EA4\u6362\u540E\u7684\u724C\u7EC4\u5B8C\u5168\u5408\u6CD5\uFF0C\u53EF\u4EE5\u751F\u6548\u3002") : null,
          h(
            "div",
            { class: "batch-actions" },
            h("button", {
              class: "btn btn-primary",
              disabled: !batch.legal,
              title: batch.legal ? "\u6574\u6279\u4E8B\u52A1\u63D0\u4EA4" : "\u6574\u6279\u5B58\u5728\u9519\u8BEF\uFF0C\u4E0D\u80FD\u90E8\u5206\u751F\u6548",
              onclick: () => {
                if (!batch.legal || !batch.final) return;
                store.replaceDeck(deck2.id, batch.final);
                draft = [newDraft()];
                appliedNote = `\u5DF2\u5E94\u7528 ${validPairs.length} \u5BF9\u4E92\u6362\uFF08\u6574\u6279\u4E8B\u52A1\uFF09\u3002\u53EF\u5230\u300C\u724C\u7EC4\u6821\u9A8C\u300D\u67E5\u770B\u65B0\u724C\u7EC4\u3002`;
                update();
              }
            }, batch.legal ? `\u6574\u6279\u5E94\u7528 ${validPairs.length} \u5BF9\u4EA4\u6362` : "\u6574\u6279\u4E0D\u5408\u6CD5\uFF0C\u5DF2\u963B\u6B62\u751F\u6548"),
            h("span", { class: "muted small" }, batch.legal ? "\u6240\u6709\u79FB\u52A8\u4F5C\u4E3A\u4E00\u4E2A\u6574\u4F53\u63D0\u4EA4\u3002" : "\u4E0D\u4F1A\u5E94\u7528\u5176\u4E2D\u4EFB\u4F55\u4E00\u5BF9\u3002")
          )
        ] : h("p", { class: "muted" }, "\u5148\u5728\u4E0A\u65B9\u81F3\u5C11\u9009\u5B8C\u6574\u7684\u4E00\u5BF9\u724C\u3002")
      );
      const analysis = h("section", { class: "analysis-list" }, ...analyses.map((a, i) => pairCard(a, i, update)));
      el.appendChild(pickerRow);
      el.appendChild(intro);
      if (note) el.appendChild(note);
      el.appendChild(presets);
      el.appendChild(editor);
      el.appendChild(batchPanel);
      if (analysis.children.length) el.appendChild(h("h2", { class: "section-title analysis-title" }, "\u9010\u5BF9\u89C4\u5219\u5F52\u56E0"));
      el.appendChild(analysis);
    }
    update();
    return { el, onStoreChange: update };
  }

  // src/rng.ts
  function hashSeed(text) {
    let h2 = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h2 ^= text.charCodeAt(i);
      h2 = Math.imul(h2, 16777619);
    }
    return h2 >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
      a |= 0;
      a = a + 1831565813 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function makeRng(seedText2) {
    const seedNum = hashSeed(seedText2);
    return { seedNum, rng: mulberry32(seedNum) };
  }
  function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // src/opening.ts
  function eligibilityInHand(hand, pool = CURRENT_POOL) {
    const ids = new Set(hand.map((c) => c.cardId));
    const factions = hand.map((c) => pool.cardById.get(c.cardId)?.faction);
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const inst of hand) {
      if (seen.has(inst.cardId)) continue;
      seen.add(inst.cardId);
      const card = pool.cardById.get(inst.cardId);
      if (!card?.opening) continue;
      const rule = card.opening;
      if (rule.kind === "partner") {
        const ok = ids.has(rule.partnerId);
        const p = pool.cardById.get(rule.partnerId);
        out.push({
          cardId: card.id,
          enabled: ok,
          reason: ok ? `\u8D77\u624B\u5DF2\u5305\u542B\u300C${p?.name ?? rule.partnerId}\u300D\uFF0C\u642D\u914D\u6210\u7ACB` : `\u9700\u8981\u8D77\u624B\u540C\u65F6\u6301\u6709\u300C${p?.name ?? rule.partnerId}\u300D`
        });
      } else {
        const count2 = factions.filter((f) => f === rule.faction).length - 1;
        const ok = count2 >= rule.count;
        const fname = rule.faction;
        out.push({
          cardId: card.id,
          enabled: ok,
          reason: ok ? `\u8D77\u624B\u53E6\u6709 ${count2} \u5F20\u540C\u9700\u9635\u8425\u724C\uFF08\u8981\u6C42 \u2265${rule.count}\uFF09` : `\u8D77\u624B\u53E6\u6709 ${Math.max(count2, 0)} \u5F20${FACTION_LABEL2[fname]}\u724C\uFF0C\u8FD8\u9700 ${rule.count - Math.max(count2, 0)} \u5F20`
        });
      }
    }
    return out;
  }
  var FACTION_LABEL2 = { crimson: "\u8D64\u7130", tide: "\u82CD\u6F9C", grove: "\u68EE\u7F57", neutral: "\u4E2D\u7ACB" };
  function evaluateGoal(goal, hand, pool = CURRENT_POOL) {
    const has = (id) => hand.some((c) => c.cardId === id);
    const name = (id) => pool.cardById.get(id)?.name ?? id;
    switch (goal.kind) {
      case "combo": {
        return goal.cardIds.map((id) => ({
          pass: has(id),
          label: `\u2666 ${name(id)}`,
          detail: has(id) ? "\u5DF2\u5728\u8D77\u624B" : "\u4E0D\u5728\u8D77\u624B"
        }));
      }
      case "card-enabled": {
        const card = pool.cardById.get(goal.cardId);
        const inHand = has(goal.cardId);
        const elig = eligibilityInHand(hand, pool).find((e) => e.cardId === goal.cardId);
        return [
          { pass: inHand, label: `\u8D77\u624B\u6709 \u2666 ${name(goal.cardId)}`, detail: inHand ? "\u5DF2\u62BD\u5230" : "\u6CA1\u62BD\u5230" },
          {
            pass: inHand && !!elig?.enabled,
            label: `\u2666 ${name(goal.cardId)} \u7684\u51FA\u573A\u642D\u914D\u6210\u7ACB`,
            detail: !inHand ? "\u724C\u4E0D\u5728\u8D77\u624B\uFF0C\u65E0\u6CD5\u5224\u5B9A\u51FA\u573A\u8D44\u683C" : elig ? elig.reason : card?.opening?.text ?? "\u8BE5\u724C\u6CA1\u6709\u989D\u5916\u8D44\u683C\u8981\u6C42"
          }
        ];
      }
      case "faction-count": {
        const n = hand.filter((c) => pool.cardById.get(c.cardId)?.faction === goal.faction).length;
        return [
          {
            pass: n >= goal.count,
            label: `\u8D77\u624B ${FACTION_LABEL2[goal.faction]}\u724C \u2265 ${goal.count}`,
            detail: `\u5F53\u524D ${n} \u5F20`
          }
        ];
      }
      case "any": {
        const subResults = goal.goals.map((g) => ({ g, checks: evaluateGoal(g, hand, pool) }));
        const passed = subResults.find((r) => r.checks.every((c) => c.pass));
        return [
          {
            pass: !!passed,
            label: goal.label,
            detail: passed ? `\u6EE1\u8DB3\u5206\u652F\uFF1A${passed.g.label}` : ` ${goal.goals.length} \u4E2A\u5206\u652F\u5747\u672A\u8FBE\u6210`
          }
        ];
      }
    }
  }
  function suggestMulligan(goal, hand, pool = CURRENT_POOL) {
    const keepIds = /* @__PURE__ */ new Set();
    const keepFactions = /* @__PURE__ */ new Set();
    const planFor = (g) => {
      if (g.kind === "combo") g.cardIds.forEach((id) => keepIds.add(id));
      else if (g.kind === "card-enabled") {
        keepIds.add(g.cardId);
        const card = pool.cardById.get(g.cardId);
        if (card?.opening?.kind === "partner") keepIds.add(card.opening.partnerId);
        if (card?.opening?.kind === "faction-other") keepFactions.add(card.opening.faction);
      } else if (g.kind === "faction-count") keepFactions.add(g.faction);
      else g.goals.forEach(planFor);
    };
    planFor(goal);
    const mull = hand.filter((c) => {
      if (keepIds.has(c.cardId)) return false;
      const f = pool.cardById.get(c.cardId)?.faction;
      if (f && keepFactions.has(f)) return false;
      return true;
    });
    return mull.length === 0 ? hand.slice() : mull;
  }
  function createSession(deck2, seedText2, pool = CURRENT_POOL) {
    const { seedNum, rng } = makeRng(seedText2);
    const all = shuffleInPlace(expandZone(deck2, "main", pool), rng);
    const hand = all.splice(0, RULES.openingHandSize);
    return { seedText: seedText2, seedNum, rng, hand, library: all, mulliganUsed: false };
  }
  function applyMulligan(session2, iids) {
    if (session2.mulliganUsed) return session2;
    const chosen2 = new Set(iids);
    const sentBack = session2.hand.filter((c) => chosen2.has(c.iid));
    if (sentBack.length === 0) return session2;
    const kept = session2.hand.filter((c) => !chosen2.has(c.iid));
    const library = shuffleInPlace([...session2.library, ...sentBack], session2.rng);
    const drawn = library.splice(0, sentBack.length);
    return {
      ...session2,
      hand: [...kept, ...drawn],
      library,
      mulliganUsed: true,
      lastMulligan: { sentBack, drawn }
    };
  }
  function trialForSeed(deck2, seedNum, policy2, pool = CURRENT_POOL) {
    const rng = mulberry32(seedNum >>> 0);
    const all = shuffleInPlace(expandZone(deck2, "main", pool), rng);
    const initial = all.splice(0, RULES.openingHandSize);
    const firstChecks = evaluateGoal(deck2.goal, initial, pool);
    const firstPass = firstChecks.every((c) => c.pass);
    let finalHand = initial;
    let mulliganed = [];
    let drawn = [];
    if (!firstPass && policy2 !== "none") {
      const toMull = policy2 === "all" ? initial.slice() : suggestMulligan(deck2.goal, initial, pool);
      const iids = new Set(toMull.map((c) => c.iid));
      mulliganed = toMull;
      const kept = initial.filter((c) => !iids.has(c.iid));
      const library = shuffleInPlace([...all, ...toMull], rng);
      drawn = library.splice(0, toMull.length);
      finalHand = [...kept, ...drawn];
    }
    const finalChecks = evaluateGoal(deck2.goal, finalHand, pool);
    const finalPass = finalChecks.every((c) => c.pass);
    return {
      seedKey: String(seedNum),
      seedNum,
      initial,
      mulliganed,
      kept: initial.filter((c) => !new Set(mulliganed.map((m) => m.iid)).has(c.iid)),
      drawn,
      finalHand,
      firstChecks,
      finalChecks,
      firstPass,
      finalPass,
      policy: policy2
    };
  }

  // src/ui/hand.ts
  function handTile(inst, opts = {}) {
    const card = CURRENT_POOL.cardById.get(inst.cardId);
    const faction = card ? FACTIONS[card.faction] : void 0;
    const printing = card?.printings.find((p) => p.id === inst.printingId);
    const classes = ["hand-tile"];
    if (opts.mark === "out") classes.push("tile-out");
    if (opts.mark === "drawn") classes.push("tile-drawn");
    if (opts.selected) classes.push("tile-selected");
    if (opts.status) classes.push(opts.status.enabled ? "tile-eligible" : "tile-ineligible");
    const checkbox = opts.selectable && card ? h("input", {
      type: "checkbox",
      class: "tile-check",
      checked: !!opts.selected,
      onchange: (e) => opts.onToggle?.(inst.iid, e.target.checked)
    }) : null;
    const eligBadge = opts.status ? h(
      "div",
      { class: `elig-badge ${opts.status.enabled ? "elig-ok" : "elig-no"}`, title: opts.status.reason },
      opts.status.enabled ? "\u8D44\u683C\u6210\u7ACB" : "\u6682\u65E0\u8D44\u683C"
    ) : null;
    return h(
      "label",
      {
        class: classes.join(" "),
        style: faction ? `--faction:${faction.color};--faction-soft:${faction.soft}` : void 0
      },
      checkbox,
      h("div", { class: "tile-cost" }, card ? costBadge(card.cost) : "?"),
      h("div", { class: "tile-diamond", style: faction ? `color:${faction.color}` : "" }, "\u2666"),
      h("div", { class: "tile-name" }, card?.name ?? inst.cardId),
      h("div", { class: "tile-meta" }, faction?.name ?? "?", " \xB7 ", card?.type === "core" ? "\u6838\u5FC3" : printing?.label ?? inst.printingId),
      card?.text ? h("div", { class: "tile-text" }, card.text) : null,
      eligBadge,
      opts.status ? h("div", { class: "elig-reason" }, opts.status.reason) : null,
      opts.mark === "out" ? h("div", { class: "tile-stamp stamp-out" }, "\u5DF2\u6362\u8D70") : null,
      opts.mark === "drawn" ? h("div", { class: "tile-stamp stamp-drawn" }, "\u6362\u5165") : null,
      opts.overlay ?? null
    );
  }

  // src/ui/tab-opening.ts
  var seedText = "FABLE-16289";
  var sessionDeckId = null;
  var session = null;
  var chosen = /* @__PURE__ */ new Set();
  function ensureSession() {
    const deck2 = store.selectedDeck;
    if (sessionDeckId !== deck2.id || !session) {
      sessionDeckId = deck2.id;
      session = createSession(deck2, seedText);
      chosen = /* @__PURE__ */ new Set();
    }
  }
  function goalPanel(s) {
    const deck2 = store.selectedDeck;
    const checks = evaluateGoal(deck2.goal, s.hand);
    const pass = checks.every((c) => c.pass);
    return h(
      "div",
      { class: `goal-panel ${pass ? "goal-pass" : "goal-fail"}` },
      h("div", { class: "goal-head" }, h("strong", null, `\u5F00\u5C40\u6761\u4EF6\uFF1A${deck2.goal.label}`), h("span", { class: `verdict-badge ${pass ? "verdict-ok" : "verdict-bad"}` }, pass ? "\u5DF2\u6EE1\u8DB3" : "\u672A\u6EE1\u8DB3")),
      h("ul", { class: "goal-checks" }, ...checks.map((c) => h("li", { class: c.pass ? "check-ok" : "check-no" }, h("span", null, c.pass ? "\u2713" : "\u2715"), h("span", null, c.label), h("span", { class: "muted small" }, c.detail))))
    );
  }
  function createOpeningTab() {
    const el = h("div", { class: "tab-opening" });
    function update() {
      clear(el);
      ensureSession();
      const s = session;
      const deck2 = store.selectedDeck;
      const elig = eligibilityInHand(s.hand);
      const eligMap = new Map(elig.map((e) => [e.cardId, e]));
      const toolbar = h(
        "div",
        { class: "tab-toolbar card-panel wrap" },
        deckPicker(deck2.id, (id) => {
          store.select(id);
          sessionDeckId = null;
          update();
        }, store.decks),
        h(
          "label",
          { class: "seed-field" },
          h("span", { class: "picker-label" }, "\u56FA\u5B9A\u79CD\u5B50"),
          (() => {
            const inp = h("input", {
              class: "seed-input",
              value: seedText,
              onchange: (e) => {
                seedText = e.target.value || "0";
              }
            });
            return inp;
          })()
        ),
        h("button", {
          class: "btn btn-primary",
          onclick: () => {
            session = createSession(deck2, seedText);
            chosen = /* @__PURE__ */ new Set();
            update();
          }
        }, "\u6309\u79CD\u5B50\u62BD\u8D77\u624B"),
        h("button", {
          class: "btn",
          onclick: () => {
            seedText = `seed-${Math.floor(Math.random() * 1e9).toString(36)}`;
            session = createSession(deck2, seedText);
            chosen = /* @__PURE__ */ new Set();
            update();
          }
        }, "\u968F\u673A\u4E00\u4E2A\u79CD\u5B50"),
        h("span", { class: "seed-num mono small muted" }, `seedNum = ${s.seedNum >>> 0}`)
      );
      const rule = h(
        "div",
        { class: "explain card-panel" },
        `\u89C4\u5219\uFF1A\u4E3B\u724C 40 \u5F20\u6D17\u724C\u540E\u62BD ${RULES.openingHandSize} \u5F20\u8D77\u624B\uFF1B\u6BD4\u8D5B\u524D\u7684\u8D77\u624B\u8C03\u5EA6\u53EA\u5141\u8BB8\u4E00\u6B21 \u2014\u2014 \u52FE\u9009\u4EFB\u610F\u6570\u91CF\u7684\u724C\u6D17\u56DE\u724C\u5E93\uFF0C\u518D\u62BD\u7B49\u91CF\u3002\u67D0\u4E9B\u724C\u7684\u51FA\u573A\u8D44\u683C\u4F1A\u5B9E\u65F6\u68C0\u67E5\u8D77\u624B\u642D\u914D\u3002`
      );
      const tiles = s.hand.map((inst) => {
        const status = eligMap.get(inst.cardId);
        if (!s.mulliganUsed) {
          return handTile(inst, {
            status,
            selectable: true,
            selected: chosen.has(inst.iid),
            onToggle: (iid, checked) => {
              if (checked) chosen.add(iid);
              else chosen.delete(iid);
              update();
            }
          });
        }
        const isDrawn = s.lastMulligan?.drawn.some((d) => d.iid === inst.iid);
        return handTile(inst, { status, mark: isDrawn ? "drawn" : "kept" });
      });
      const handPanel = h(
        "section",
        { class: "card-panel hand-panel" },
        h(
          "div",
          { class: "hand-panel-head" },
          h("h2", { class: "section-title" }, s.mulliganUsed ? "\u6362\u624B\u540E\u7684\u8D77\u624B\uFF08\u6700\u7EC8\uFF09" : "\u521D\u59CB\u8D77\u624B\uFF08\u52FE\u9009\u8981\u6362\u8D70\u7684\u724C\uFF09"),
          h(
            "div",
            { class: "hand-actions" },
            s.mulliganUsed ? h("span", { class: "tag" }, "\u6362\u624B\u673A\u4F1A\u5DF2\u4F7F\u7528") : [
              h("button", { class: "btn btn-small", onclick: () => {
                chosen = new Set(s.hand.map((c) => c.iid));
                update();
              } }, "\u5168\u9009"),
              h("button", { class: "btn btn-small", onclick: () => {
                chosen = /* @__PURE__ */ new Set();
                update();
              } }, "\u6E05\u7A7A"),
              h("button", {
                class: "btn btn-small btn-primary",
                disabled: chosen.size === 0,
                onclick: () => {
                  session = applyMulligan(s, [...chosen]);
                  chosen = /* @__PURE__ */ new Set();
                  update();
                }
              }, `\u6362\u624B\u4E00\u6B21\uFF08\u6362\u8D70 ${chosen.size} \u5F20\uFF09`)
            ]
          )
        ),
        h("div", { class: "hand-row" }, ...tiles),
        s.lastMulligan ? h(
          "div",
          { class: "mulligan-summary" },
          h("div", null, h("strong", null, "\u6D17\u56DE\uFF1A"), s.lastMulligan.sentBack.map((c) => cardLabel(c.cardId)).join("\u3001")),
          h("div", null, h("strong", null, "\u65B0\u62BD\uFF1A"), s.lastMulligan.drawn.map((c) => cardLabel(c.cardId)).join("\u3001"))
        ) : null
      );
      const outPanel = s.lastMulligan ? h(
        "section",
        { class: "card-panel" },
        h("h2", { class: "section-title" }, "\u672C\u6B21\u6362\u8D70\u7684\u724C"),
        h("div", { class: "hand-row hand-row-small" }, ...s.lastMulligan.sentBack.map((c) => handTile(c, { mark: "out" })))
      ) : null;
      const eligPanel = h(
        "section",
        { class: "card-panel" },
        h("h2", { class: "section-title" }, "\u8D77\u624B\u4E2D\u7684\u51FA\u573A\u8D44\u683C"),
        elig.length ? h("div", { class: "elig-list" }, ...elig.map((e) => h(
          "div",
          { class: `elig-row ${e.enabled ? "is-ok" : "is-no"}` },
          h("span", { class: `elig-dot ${e.enabled ? "dot-ok" : "dot-bad"}` }),
          h("strong", null, cardLabel(e.cardId)),
          h("span", { class: "muted" }, e.reason)
        ))) : h("p", { class: "muted" }, "\u8FD9\u628A\u624B\u724C\u91CC\u6CA1\u6709\u5E26\u8D77\u624B\u642D\u914D\u9650\u5236\u7684\u724C\u3002")
      );
      el.appendChild(toolbar);
      el.appendChild(rule);
      el.appendChild(goalPanel(s));
      el.appendChild(handPanel);
      if (outPanel) el.appendChild(outPanel);
      el.appendChild(eligPanel);
    }
    update();
    return { el, onStoreChange: () => {
      sessionDeckId = null;
      update();
    } };
  }
  function cardLabel(cardId) {
    return `\u2666 ${CURRENT_POOL.cardById.get(cardId)?.name ?? cardId}`;
  }

  // src/ui/traceModal.ts
  function checksBlock(trace, which, deck2) {
    const checks = which === "first" ? trace.firstChecks : trace.finalChecks;
    const pass = which === "first" ? trace.firstPass : trace.finalPass;
    return h(
      "div",
      { class: `trace-checks ${pass ? "is-ok" : "is-no"}` },
      h(
        "div",
        { class: "trace-checks-head" },
        h("strong", null, which === "first" ? "\u521D\u59CB\u8D77\u624B\u5224\u5B9A" : "\u8C03\u5EA6\u540E\u5224\u5B9A"),
        h("span", { class: `verdict-badge ${pass ? "verdict-ok" : "verdict-bad"}` }, pass ? "\u6EE1\u8DB3" : "\u4E0D\u6EE1\u8DB3")
      ),
      h(
        "ul",
        { class: "goal-checks" },
        ...checks.map((c) => h(
          "li",
          { class: c.pass ? "check-ok" : "check-no" },
          h("span", null, c.pass ? "\u2713" : "\u2715"),
          h("span", null, c.label),
          h("span", { class: "muted small" }, c.detail)
        ))
      ),
      which === "first" ? h("div", { class: "muted small" }, `\u76EE\u6807\uFF1A${deck2.goal.label}`) : null
    );
  }
  function handWithEligibility(trace, which) {
    const hand = which === "initial" ? trace.initial : trace.finalHand;
    const eligMap = new Map(eligibilityInHand(hand, CURRENT_POOL).map((e) => [e.cardId, e]));
    const drawnIds = new Set(trace.drawn.map((c) => c.iid));
    return h(
      "div",
      { class: "trace-hand-block" },
      h("div", { class: "trace-hand-label" }, which === "initial" ? "\u5F53\u65F6\u7684\u521D\u59CB\u8D77\u624B\uFF085 \u5F20\uFF09" : "\u6362\u624B\u540E\u7684\u6700\u7EC8\u8D77\u624B"),
      h(
        "div",
        { class: "hand-row" },
        ...hand.map((inst) => handTile(inst, {
          status: eligMap.get(inst.cardId),
          mark: which === "final" && drawnIds.has(inst.iid) ? "drawn" : void 0
        }))
      )
    );
  }
  function openTraceBrowser(deck2, traces, startIndex = 0, title) {
    let idx = Math.max(0, Math.min(startIndex, traces.length - 1));
    const content = h("div", { class: "trace-browser" });
    function renderContent() {
      content.replaceChildren();
      if (traces.length === 0) {
        content.appendChild(h("p", { class: "muted" }, "\u6CA1\u6709\u53EF\u67E5\u770B\u7684\u6837\u672C\u3002"));
        return;
      }
      const trace = traces[idx];
      const seedSelect = h(
        "select",
        {
          class: "seed-pick-select",
          onchange: (e) => {
            idx = e.target.selectedIndex;
            renderContent();
          }
        },
        ...traces.map((t, i) => h("option", { selected: i === idx }, `\u79CD\u5B50 #${t.seedNum}\uFF08\u7B2C ${t.seedKey} \u6279\uFF09`))
      );
      seedSelect.selectedIndex = idx;
      const head = h(
        "div",
        { class: "trace-browser-head" },
        h("button", { class: "btn btn-small", disabled: idx === 0, onclick: () => {
          idx -= 1;
          renderContent();
        } }, "\u2190 \u4E0A\u4E00\u4E2A\u5931\u8D25"),
        seedSelect,
        h("button", { class: "btn btn-small", disabled: idx >= traces.length - 1, onclick: () => {
          idx += 1;
          renderContent();
        } }, "\u4E0B\u4E00\u4E2A\u5931\u8D25 \u2192"),
        h("span", { class: "muted small" }, `${idx + 1} / ${traces.length}`)
      );
      const mullBlock = trace.mulliganed.length ? h(
        "div",
        { class: "trace-mull" },
        h("div", { class: "trace-hand-label" }, `\u6309\u300C${trace.policy === "all" ? "\u5168\u90E8\u6362\u8D70" : "\u667A\u80FD\u7559\u724C"}\u300D\u7B56\u7565\u6362\u8D70 ${trace.mulliganed.length} \u5F20`),
        h("div", { class: "hand-row hand-row-small" }, ...trace.mulliganed.map((c) => handTile(c, { mark: "out" })))
      ) : h("p", { class: "muted small" }, trace.policy === "none" ? "\u7B56\u7565\u4E3A\u4E0D\u6362\u624B\u3002" : "\u521D\u59CB\u8D77\u624B\u5DF2\u8FBE\u6807\uFF0C\u6CA1\u6709\u6362\u624B\u3002");
      content.appendChild(head);
      content.appendChild(h("div", { class: "trace-seed-line mono" }, `seed = ${trace.seedNum}\uFF08\u540C\u4E00\u6570\u5B57\u79CD\u5B50\u5BF9\u6240\u6709\u724C\u7EC4\u4EA7\u751F\u76F8\u540C\u7684\u968F\u673A\u5E8F\u5217\u8D77\u70B9\uFF09`));
      content.appendChild(handWithEligibility(trace, "initial"));
      content.appendChild(checksBlock(trace, "first", deck2));
      content.appendChild(mullBlock);
      if (trace.mulliganed.length) {
        content.appendChild(handWithEligibility(trace, "final"));
        content.appendChild(checksBlock(trace, "final", deck2));
      }
    }
    renderContent();
    openModal(title ?? `\u5931\u8D25\u6837\u672C \xB7 ${deck2.name}`, content, { wide: true });
  }

  // src/ui/tab-simulate.ts
  var selectedIds = /* @__PURE__ */ new Set(["deck-aggro", "deck-combo", "deck-grove", "deck-cycle"]);
  var count = 1e3;
  var baseSeed = 1;
  var policy = "smart";
  var results = null;
  var lastRunKey = "";
  function pct(n, d) {
    return d === 0 ? "\u2014" : `${(n / d * 100).toFixed(1)}%`;
  }
  function rateBar(r, total, rerender) {
    const finalRate = r.finalPass / total;
    const firstRate = r.firstPass / total;
    const deck2 = store.decks.find((d) => d.id === r.deckId);
    return h(
      "div",
      { class: "rate-cell" },
      h(
        "div",
        { class: "rate-bar-track", title: `\u8C03\u5EA6\u540E ${pct(r.finalPass, total)}\uFF1B\u521D\u59CB ${pct(r.firstPass, total)}` },
        h("div", { class: "rate-bar-fill", style: `width:${(finalRate * 100).toFixed(2)}%` }),
        h("div", {
          class: "rate-tick",
          style: `left:calc(${(firstRate * 100).toFixed(2)}% - 1px)`,
          title: `\u521D\u59CB\u8D77\u624B\u8FBE\u6807\u7387 ${pct(r.firstPass, total)}`
        })
      ),
      h(
        "div",
        { class: "rate-labels" },
        h("span", { class: "rate-final" }, pct(r.finalPass, total)),
        h("span", { class: "rate-first muted small" }, `\u521D\u59CB ${pct(r.firstPass, total)}`),
        h("button", {
          class: "link-btn",
          disabled: r.finalFailed.length === 0,
          onclick: () => openTraceBrowser(deck2, r.finalFailed, 0, `\u8C03\u5EA6\u540E\u4ECD\u5931\u8D25 \xB7 ${deck2.name}`)
        }, `\u770B ${r.finalFailed.length} \u4E2A\u8C03\u5EA6\u540E\u5931\u8D25\u4F8B`),
        h("button", {
          class: "link-btn muted-link",
          disabled: r.firstFailed.length === 0,
          onclick: () => openTraceBrowser(deck2, r.firstFailed, 0, `\u521D\u59CB\u8D77\u624B\u5931\u8D25 \xB7 ${deck2.name}`)
        }, `\u521D\u59CB\u5931\u8D25 ${r.firstFailed.length}`)
      )
    );
  }
  function createSimulateTab() {
    const el = h("div", { class: "tab-sim" });
    function run() {
      const ids = store.decks.filter((d) => selectedIds.has(d.id)).map((d) => d.id);
      const n = Math.max(1, Math.min(5e3, count | 0 || 1));
      results = ids.map((id) => {
        const deck2 = store.decks.find((d) => d.id === id);
        const traces = [];
        for (let i = 0; i < n; i++) traces.push(trialForSeed(deck2, baseSeed + i >>> 0, policy));
        return {
          deckId: id,
          traces,
          firstPass: traces.filter((t) => t.firstPass).length,
          finalPass: traces.filter((t) => t.finalPass).length,
          finalFailed: traces.filter((t) => !t.finalPass),
          firstFailed: traces.filter((t) => !t.firstPass)
        };
      });
      lastRunKey = `${n}-${baseSeed}-${policy}-${ids.join("|")}`;
    }
    function update() {
      clear(el);
      const controls = h(
        "section",
        { class: "card-panel sim-controls" },
        sectionTitle("\u540C\u4E00\u6279\u79CD\u5B50\uFF0C\u6A2A\u8BC4\u4E0D\u540C\u724C\u7EC4", "\u6BCF\u4E2A\u724C\u7EC4\u5BF9 seed = base \u2026 base+N-1 \u5404\u81EA\u4ECE\u5B8C\u5168\u76F8\u540C\u7684\u6570\u5B57\u79CD\u5B50\u6D17\u724C\uFF0C\u7ED3\u679C\u53EF\u590D\u73B0\u3002"),
        h(
          "div",
          { class: "control-grid" },
          h(
            "label",
            { class: "control-field" },
            h("span", null, "\u79CD\u5B50\u6570\u91CF N"),
            (() => {
              const inp = h("input", { type: "number", min: "1", max: "5000", value: String(count) });
              inp.addEventListener("change", () => {
                count = Number(inp.value) || 1;
              });
              return inp;
            })()
          ),
          h(
            "label",
            { class: "control-field" },
            h("span", null, "\u8D77\u59CB\u79CD\u5B50 base"),
            (() => {
              const inp = h("input", { type: "number", value: String(baseSeed) });
              inp.addEventListener("change", () => {
                baseSeed = Number(inp.value) || 1;
              });
              return inp;
            })()
          ),
          h(
            "label",
            { class: "control-field" },
            h("span", null, "\u8BD5\u62BD\u6362\u624B\u7B56\u7565\uFF08\u4EC5\u521D\u59CB\u4E0D\u8FBE\u6807\u65F6\u6362\u4E00\u6B21\uFF09"),
            (() => {
              const sel = h(
                "select",
                null,
                h("option", { value: "smart", selected: policy === "smart" }, "\u667A\u80FD\u7559\u724C\uFF1A\u4FDD\u7559\u7EC4\u5408\u4EF6 / \u540C\u9635\u8425\u8D21\u732E\u724C"),
                h("option", { value: "all", selected: policy === "all" }, "\u5168\u90E8\u6362\u8D70\uFF0C\u91CD\u62BD 5 \u5F20"),
                h("option", { value: "none", selected: policy === "none" }, "\u4E0D\u6362\u624B")
              );
              sel.value = policy;
              sel.addEventListener("change", () => {
                policy = sel.value;
              });
              return sel;
            })()
          ),
          h(
            "div",
            { class: "control-run" },
            h("button", { class: "btn btn-primary", onclick: () => {
              run();
              update();
            } }, "\u5F00\u59CB\u8BD5\u62BD\u5BF9\u6BD4")
          )
        ),
        h(
          "div",
          { class: "deck-checks" },
          ...store.decks.map((d) => {
            const v = validateDeck(d);
            const cb = h("input", { type: "checkbox" });
            cb.checked = selectedIds.has(d.id);
            cb.addEventListener("change", () => {
              if (cb.checked) selectedIds.add(d.id);
              else selectedIds.delete(d.id);
              update();
            });
            return h(
              "label",
              { class: `deck-check ${v.legal ? "" : "is-illegal-deck"}` },
              cb,
              h("span", { class: `valid-dot ${v.legal ? "is-legal" : "is-illegal"}` }),
              h("span", null, d.name),
              v.legal ? null : h("span", { class: "tag tag-danger" }, `\u89C4\u5219\u4E0D\u5408\u6CD5 \xD7${v.errors.length}`)
            );
          })
        )
      );
      el.appendChild(controls);
      if (!results) {
        run();
      }
      if (results && results.length) {
        const total = results[0].traces.length;
        const table = h(
          "section",
          { class: "card-panel sim-result" },
          h(
            "div",
            { class: "sim-legend muted small" },
            h("span", { class: "legend-swatch bar-swatch" }),
            "\u5F69\u8272\u6761 = \u6362\u624B\u540E\u8FBE\u6807\u7387",
            h("span", { class: "legend-tick" }),
            "\u7AD6\u7EBF = \u521D\u59CB\u8D77\u624B\u8FBE\u6807\u7387",
            " \xB7 \u6BD4\u7387\u65C1\u7684\u6309\u94AE\u53EF\u4EE5\u70B9\u5F00\u5177\u4F53\u5931\u8D25\u6837\u672C\uFF08\u542B\u5F53\u65F6\u624B\u724C\u4E0E\u5224\u5B9A\uFF09"
          ),
          h(
            "div",
            { class: "sim-table" },
            h(
              "div",
              { class: "sim-row sim-head" },
              h("div", { class: "sim-name" }, "\u724C\u7EC4"),
              h("div", { class: "sim-goal" }, "\u5F00\u5C40\u6761\u4EF6"),
              h("div", { class: "sim-bar-head" }, "\u8FBE\u6807\u7387\u5BF9\u6BD4"),
              h("div", { class: "sim-num" }, "\u521D\u59CB"),
              h("div", { class: "sim-num" }, "\u6362\u624B\u540E")
            ),
            ...results.map((r) => {
              const deck2 = store.decks.find((d) => d.id === r.deckId);
              const v = validateDeck(deck2);
              return h(
                "div",
                { class: "sim-row" },
                h(
                  "div",
                  { class: "sim-name" },
                  h("span", { class: `valid-dot ${v.legal ? "is-legal" : "is-illegal"}` }),
                  h("strong", null, deck2.name),
                  v.legal ? null : h("span", { class: "tag tag-danger" }, "\u4E0D\u5408\u6CD5\u4ECD\u53EF\u8BD5\u62BD")
                ),
                h("div", { class: "sim-goal muted small" }, deck2.goal.label),
                rateBar(r, total, update),
                h("div", { class: "sim-num" }, `${r.firstPass}/${total} \xB7 ${pct(r.firstPass, total)}`),
                h("div", { class: "sim-num sim-num-final" }, `${r.finalPass}/${total} \xB7 ${pct(r.finalPass, total)}`)
              );
            })
          )
        );
        el.appendChild(table);
      } else {
        el.appendChild(h("div", { class: "card-panel empty-hint" }, "\u81F3\u5C11\u52FE\u9009\u4E00\u4E2A\u724C\u7EC4\u518D\u5F00\u59CB\u3002"));
      }
    }
    update();
    return {
      el,
      onStoreChange: () => {
        results = null;
        update();
      }
    };
  }

  // src/io.ts
  var APP_ID = "diamond-deck-lab";
  var EXPORT_FORMAT = 1;
  function exportDeck(deck2, pool = CURRENT_POOL) {
    const used = /* @__PURE__ */ new Set();
    const pick = (e) => {
      if (e.kind === "unresolved") {
        return { cardId: e.cardId, printingId: e.printingId, count: e.count };
      }
      used.add(e.cardId);
      return { cardId: e.cardId, printingId: e.printingId, count: e.count };
    };
    const main = deck2.main.map(pick).filter((x) => !!x);
    const sideboard = deck2.sideboard.map(pick).filter((x) => !!x);
    const cards = {};
    for (const id of used) {
      const c = pool.cardById.get(id);
      if (!c || !cards) continue;
      const printings = {};
      for (const p of c.printings) printings[p.id] = p.label;
      cards[id] = { name: c.name, printings };
    }
    const file = {
      app: APP_ID,
      format: EXPORT_FORMAT,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      poolVersion: pool.version,
      deck: {
        name: deck2.name,
        tag: deck2.tag,
        description: deck2.description,
        goal: deck2.goal,
        main,
        sideboard
      },
      snapshot: { cards }
    };
    return JSON.stringify(file, null, 2);
  }
  function asEntryList(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === "object" && x !== null).map((x) => ({
      cardId: String(x.cardId ?? ""),
      printingId: x.printingId != null ? String(x.printingId) : void 0,
      count: Number(x.count ?? 1) || 1
    })).filter((x) => x.cardId);
  }
  function previewImport(text, targetPool2) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON \u89E3\u6790\u5931\u8D25\uFF1A${err.message}`);
    }
    const obj = raw;
    const d = obj.deck ?? obj;
    if (!d || typeof d !== "object") throw new Error("\u6587\u4EF6\u91CC\u6CA1\u6709\u627E\u5230 deck \u724C\u7EC4\u5BF9\u8C61\u3002");
    const snapshotCards = obj.snapshot?.cards ?? {};
    const sourcePoolVersion = typeof obj.poolVersion === "string" ? obj.poolVersion : void 0;
    const rows = [];
    const buildRow = (zone, e, idx) => {
      const snap = snapshotCards[e.cardId];
      const exportedName = snap?.name ?? e.cardId;
      const exportedPrintingLabel = e.printingId ? snap?.printings?.[e.printingId] : void 0;
      const card = targetPool2.cardById.get(e.cardId);
      const base = {
        rowId: `${zone}-${idx}-${e.cardId}-${e.printingId ?? "none"}`,
        zone,
        cardId: e.cardId,
        printingId: e.printingId,
        count: e.count,
        exportedName,
        exportedPrintingLabel,
        status: "removed",
        statusText: "",
        candidates: [],
        choice: { mode: "default" }
      };
      if (card) {
        const printingOk = !e.printingId || card.printings.some((p) => p.id === e.printingId);
        if (printingOk) {
          base.status = "exact";
          base.statusText = "\u724C\u4E0E\u5370\u6B21\u90FD\u5339\u914D";
          base.resolvedCardId = card.id;
        } else {
          base.status = "printing-missing";
          base.statusText = `\u724C\u4ECD\u5728\uFF0C\u4F46\u5370\u6B21 ${e.printingId} \u5728 ${targetPool2.version} \u5361\u6C60\u4E2D\u4E0D\u5B58\u5728`;
          base.resolvedCardId = card.id;
          base.fallbackPrintingId = card.printings[0]?.id;
        }
        return base;
      }
      const sameName = targetPool2.cards.filter((c) => c.name === exportedName && c.id !== e.cardId);
      base.candidates = sameName.map((c) => ({ id: c.id, name: c.name }));
      if (sameName.length > 0) {
        base.status = "same-name";
        base.statusText = `\u65B0\u7248\u672C\u6CA1\u6709 id \u4E3A ${e.cardId} \u7684\u724C\uFF1B\u4F46\u6709\u540C\u540D\u5F02 id \u724C\uFF0C\u672A\u81EA\u52A8\u66FF\u6362`;
      } else {
        base.status = "removed";
        base.statusText = `\u65B0\u7248\u672C\u5DF2\u65E0\u6B64\u724C\uFF08id\uFF1A${e.cardId}\uFF09\uFF0C\u4E5F\u6CA1\u6709\u540C\u540D\u724C`;
      }
      base.choice = { mode: "unresolved" };
      return base;
    };
    asEntryList(d.main).forEach((e, i) => rows.push(buildRow("main", e, i)));
    asEntryList(d.sideboard).forEach((e, i) => rows.push(buildRow("sideboard", e, i)));
    return {
      sourcePoolVersion,
      deckName: typeof d.name === "string" && d.name ? d.name : "\u5BFC\u5165\u7684\u724C\u7EC4",
      tag: d.tag,
      description: d.description,
      goal: d.goal,
      rows
    };
  }
  function deckFromPreview(preview2, targetPool2) {
    const convert = (zone) => preview2.rows.filter((r) => r.zone === zone).map((r) => {
      if (r.choice.mode === "map") {
        return {
          kind: "entry",
          uid: genUid("imp"),
          cardId: r.choice.cardId,
          printingId: r.choice.printingId || targetPool2.cardById.get(r.choice.cardId)?.printings[0]?.id || "",
          count: r.count
        };
      }
      if (r.status === "exact" && r.resolvedCardId) {
        return {
          kind: "entry",
          uid: genUid("imp"),
          cardId: r.resolvedCardId,
          printingId: r.printingId || targetPool2.cardById.get(r.resolvedCardId).printings[0].id,
          count: r.count
        };
      }
      if (r.status === "printing-missing" && r.choice.mode === "default" && r.fallbackPrintingId) {
        return {
          kind: "entry",
          uid: genUid("imp"),
          cardId: r.resolvedCardId,
          printingId: r.fallbackPrintingId,
          count: r.count
        };
      }
      return {
        kind: "unresolved",
        uid: genUid("miss"),
        cardId: r.cardId,
        printingId: r.printingId,
        count: r.count,
        exportedName: r.exportedName,
        exportedPrintingLabel: r.exportedPrintingLabel,
        sameNameCandidates: r.candidates.map((c) => c.id)
      };
    });
    return {
      id: `deck-import-${Date.now().toString(36)}`,
      name: preview2.deckName,
      tag: preview2.tag ?? "\u5BFC\u5165",
      description: preview2.description ?? "",
      goal: preview2.goal ?? { kind: "faction-count", faction: "crimson", count: 3, label: "\u8D77\u624B\u81F3\u5C11 3 \u5F20\u540C\u9635\u8425\u724C" },
      main: convert("main"),
      sideboard: convert("sideboard")
    };
  }
  var SAMPLE_OLD_EXPORT = JSON.stringify(
    {
      app: APP_ID,
      format: EXPORT_FORMAT,
      exportedAt: "2025-11-01T10:00:00.000Z",
      poolVersion: POOL_V1.version,
      deck: {
        name: "\u65E7\u7248\u8D64\u7130\u8001\u5175\u5957\uFF08v1 \u6587\u4EF6\uFF0C\u5F80 2.0 \u5BFC\uFF09",
        tag: "\u65E7\u7248\u672C\u793A\u4F8B",
        description: "\u5305\u542B 2 \u5F20\u95EA\u5370\u65E7\u8D64\u7130\u8001\u5175\uFF0C\u4EE5\u53CA 1 \u5F20\u5361\u6C60\u91CC\u4E0D\u5B58\u5728\u7684 Beta \u6D4B\u8BD5\u5370\u6B21\u708E\u5203\u3002",
        goal: { kind: "faction-count", faction: "crimson", count: 3, label: "\u8D77\u624B\u81F3\u5C11 3 \u5F20\u8D64\u7130\u724C" },
        main: [
          { cardId: "core-flame", printingId: "core-flame-o", count: 1 },
          { cardId: "c-veteran", printingId: "c-veteran-foil", count: 2 },
          { cardId: "c-blade", printingId: "c-blade-beta-test", count: 1 },
          { cardId: "c-blade", printingId: "c-blade-o", count: 3 },
          { cardId: "c-recruit", printingId: "c-recruit-o", count: 4 },
          { cardId: "c-oath", printingId: "c-oath-o", count: 4 },
          { cardId: "c-arrow", printingId: "c-arrow-o", count: 4 },
          { cardId: "c-berzerker", printingId: "c-berzerker-o", count: 4 },
          { cardId: "c-drake", printingId: "c-drake-o", count: 3 },
          { cardId: "n-courier", printingId: "n-courier-o", count: 4 },
          { cardId: "n-scholar", printingId: "n-scholar-o", count: 4 },
          { cardId: "n-golem", printingId: "n-golem-o", count: 3 },
          { cardId: "n-smith", printingId: "n-smith-o", count: 3 }
        ],
        sideboard: [{ cardId: "c-veteran", printingId: "c-veteran-o", count: 1 }]
      },
      snapshot: {
        cards: {
          "core-flame": { name: "\u8D64\u7130\u76DF\u4E3B\xB7\u70E8", printings: { "core-flame-o": "\u521D\u7248" } },
          "c-veteran": { name: "\u8D64\u7130\u8001\u5175", printings: { "c-veteran-o": "\u521D\u7248", "c-veteran-foil": "\u95EA\u5370\u7EAA\u5FF5" } },
          "c-blade": { name: "\u708E\u5203\u5251\u58EB", printings: { "c-blade-o": "\u521D\u7248", "c-blade-beta-test": "Beta \u6D4B\u8BD5\u5370\uFF08\u5DF2\u9500\u6BC1\uFF09" } },
          "c-recruit": { name: "\u8D64\u7130\u65B0\u5175", printings: { "c-recruit-o": "\u521D\u7248" } },
          "c-oath": { name: "\u8A93\u7EA6\u9A91\u58EB", printings: { "c-oath-o": "\u521D\u7248" } },
          "c-arrow": { name: "\u706B\u7BAD\u9F50\u5C04", printings: { "c-arrow-o": "\u521D\u7248" } },
          "c-berzerker": { name: "\u72C2\u65A7\u624B", printings: { "c-berzerker-o": "\u521D\u7248" } },
          "c-drake": { name: "\u5E7C\u7130\u9F99", printings: { "c-drake-o": "\u521D\u7248" } },
          "n-courier": { name: "\u884C\u5546", printings: { "n-courier-o": "\u521D\u7248" } },
          "n-scholar": { name: "\u535A\u5B66\u8005", printings: { "n-scholar-o": "\u521D\u7248" } },
          "n-golem": { name: "\u65B9\u7247\u9B54\u50CF", printings: { "n-golem-o": "\u521D\u7248" } },
          "n-smith": { name: "\u953B\u7089\u5320", printings: { "n-smith-o": "\u521D\u7248" } }
        }
      }
    },
    null,
    2
  );
  var IMPORT_POOL_CHOICES = [
    { id: POOL_V2.version, label: `${POOL_V2.version} ${POOL_V2.label}\uFF08\u5F53\u524D\u65B0\u7248\u672C\uFF09`, pool: POOL_V2 },
    { id: POOL_V1.version, label: `${POOL_V1.version} ${POOL_V1.label}\uFF08\u65E7\u7248\u672C\uFF0C\u53EF\u5BF9\u6BD4\uFF09`, pool: POOL_V1 }
  ];

  // src/ui/tab-io.ts
  var importText = "";
  var targetVersion = POOL_V2.version;
  var preview = null;
  var previewError = null;
  var importedId = null;
  function targetPool() {
    return targetVersion === POOL_V1.version ? POOL_V1 : POOL_V2;
  }
  function download(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function statusBadge(row) {
    if (row.status === "exact") return h("span", { class: "tag tag-ok" }, "\u2713 \u5B8C\u5168\u5339\u914D");
    if (row.status === "printing-missing") return h("span", { class: "tag tag-warn" }, "\u5370\u6B21\u7F3A\u5931");
    if (row.status === "same-name") return h("span", { class: "tag tag-danger" }, "\u540C\u540D\u5F02 id \xB7 \u672A\u66FF\u6362");
    return h("span", { class: "tag tag-danger" }, "\u65B0\u7248\u672C\u65E0\u6B64\u724C");
  }
  function rowControls(row, rerender) {
    const pool = targetPool();
    if (row.status === "exact") return h("span", { class: "muted small" }, "\u6309\u539F id \u4E0E\u5370\u6B21\u5BFC\u5165");
    if (row.status === "printing-missing" && row.resolvedCardId) {
      const card = pool.cardById.get(row.resolvedCardId);
      const sel = h(
        "select",
        {
          class: "mini-select",
          onchange: (e) => {
            row.fallbackPrintingId = e.target.value;
            row.choice = { mode: "default" };
          }
        },
        ...card.printings.map((p) => h("option", { value: p.id, selected: p.id === row.fallbackPrintingId }, `\u624B\u52A8\u786E\u8BA4\u5370\u6B21\uFF1A${p.label} \xB7 ${p.set}`))
      );
      sel.value = row.fallbackPrintingId ?? "";
      return h("span", { class: "row-map" }, h("span", { class: "muted small" }, "\u539F\u5370\u6B21\u4E0D\u4F1A\u88AB\u9759\u9ED8\u6539\u5199\uFF0C\u8BF7\u786E\u8BA4\u73B0\u884C\u5370\u6B21\uFF1A"), sel);
    }
    if (row.status === "same-name") {
      const mapSel = h(
        "select",
        {
          class: "mini-select",
          onchange: (e) => {
            const v = e.target.value;
            if (!v) {
              row.choice = { mode: "unresolved" };
            } else {
              const c = pool.cardById.get(v);
              row.choice = { mode: "map", cardId: v, printingId: c.printings[0]?.id ?? "" };
            }
            rerender();
          }
        },
        h("option", { value: "" }, "\u4FDD\u6301\u7F3A\u5931\uFF08\u4E0D\u81EA\u52A8\u66FF\u6362\uFF09"),
        ...row.candidates.map((c) => h("option", { value: c.id, selected: row.choice.mode === "map" && row.choice.cardId === c.id }, `\u624B\u52A8\u6620\u5C04\u5230\u65B0\u7248\uFF1A\u2666 ${c.name}\uFF08${c.id}\uFF09`))
      );
      const choice = row.choice.mode === "map" ? row.choice : null;
      let printingSel = null;
      if (choice) {
        const card = pool.cardById.get(choice.cardId);
        printingSel = h(
          "select",
          {
            class: "mini-select",
            onchange: (e) => {
              if (row.choice.mode === "map") row.choice.printingId = e.target.value;
            }
          },
          ...card.printings.map((p) => h("option", { value: p.id, selected: p.id === choice.printingId }, p.label))
        );
      }
      return h("span", { class: "row-map" }, mapSel, printingSel, h("span", { class: "muted small" }, "\u9ED8\u8BA4\u4FDD\u6301\u7F3A\u5931\uFF0C\u5BFC\u5165\u540E\u5728\u6821\u9A8C\u9875\u6301\u7EED\u62A5\u9519\u3002"));
    }
    return h("span", { class: "muted small" }, "\u53EA\u80FD\u4FDD\u6301\u7F3A\u5931\uFF1B\u4E0D\u4F1A\u6309\u540C\u540D\u731C\u6D4B\u66FF\u6362\u3002");
  }
  function createIoTab(goTab2) {
    const el = h("div", { class: "tab-io" });
    function update() {
      clear(el);
      const deck2 = store.selectedDeck;
      const exported = exportDeck(deck2, CURRENT_POOL);
      const exportArea = h("textarea", { class: "json-box", rows: 14, spellcheck: "false" });
      exportArea.value = exported;
      const exportPanel = h(
        "section",
        { class: "card-panel" },
        h("h2", { class: "section-title" }, "\u5BFC\u51FA\u724C\u7EC4\u4E0E\u5370\u6B21"),
        h("p", { class: "section-sub" }, "JSON \u540C\u65F6\u4FDD\u5B58\u7A33\u5B9A cardId\u3001\u6BCF\u6761\u9009\u62E9\u7684 printingId\uFF0C\u4EE5\u53CA\u4E00\u4EFD\u540D\u5B57 / \u5370\u6B21\u540D\u5FEB\u7167\u3002\u8BA4\u724C\u53EA\u8BA4 id\uFF0C\u4E0D\u8BA4\u540D\u5B57\u3002"),
        h(
          "div",
          { class: "tab-toolbar compact" },
          deckPicker(deck2.id, (id) => store.select(id), store.decks),
          h("button", { class: "btn btn-small btn-primary", onclick: () => download(`${deck2.id}.json`, exported) }, "\u4E0B\u8F7D .json"),
          h("button", {
            class: "btn btn-small",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(exported);
                alert("\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F");
              } catch {
                exportArea.select();
                document.execCommand("copy");
              }
            }
          }, "\u590D\u5236 JSON")
        ),
        exportArea
      );
      const importArea = h("textarea", {
        class: "json-box",
        rows: 10,
        spellcheck: "false",
        placeholder: "\u628A\u5BFC\u51FA\u7684 JSON \u7C98\u8D34\u5230\u8FD9\u91CC\uFF0C\u6216\u9009\u62E9 .json \u6587\u4EF6\u2026",
        oninput: (e) => {
          importText = e.target.value;
        }
      });
      importArea.value = importText;
      const fileInput = h("input", {
        type: "file",
        accept: ".json,application/json",
        style: "display:none",
        onchange: (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            importText = String(reader.result ?? "");
            preview = null;
            previewError = null;
            update();
          };
          reader.readAsText(file);
        }
      });
      const importPanel = h(
        "section",
        { class: "card-panel" },
        h("h2", { class: "section-title" }, "\u5BFC\u5165\u4E0E\u7248\u672C\u5DEE\u5F02\u9884\u89C8"),
        h(
          "div",
          { class: "tab-toolbar compact wrap" },
          h("label", { class: "picker-label" }, "\u6309\u54EA\u4E2A\u5361\u6C60\u7248\u672C\u9884\u89C8\uFF1A"),
          (() => {
            const sel = h(
              "select",
              {
                onchange: (e) => {
                  targetVersion = e.target.value;
                  preview = null;
                  importedId = null;
                  update();
                }
              },
              h("option", { value: POOL_V2.version, selected: targetVersion === POOL_V2.version }, `${POOL_V2.version} ${POOL_V2.label}\uFF08\u65B0\u7248\u672C\uFF09`),
              h("option", { value: POOL_V1.version, selected: targetVersion === POOL_V1.version }, `${POOL_V1.version} ${POOL_V1.label}\uFF08\u65E7\u7248\u672C\uFF09`)
            );
            sel.value = targetVersion;
            return sel;
          })(),
          h("button", { class: "btn btn-small", onclick: () => fileInput.click() }, "\u9009\u62E9 JSON \u6587\u4EF6"),
          h("button", { class: "btn btn-small", onclick: () => {
            importText = SAMPLE_OLD_EXPORT;
            preview = null;
            previewError = null;
            importedId = null;
            update();
          } }, "\u586B\u5165\u5185\u7F6E v1 \u65E7\u724C\u7EC4\u793A\u4F8B"),
          h("button", {
            class: "btn btn-small btn-primary",
            onclick: () => {
              importedId = null;
              try {
                preview = previewImport(importText, targetPool());
                previewError = null;
              } catch (err) {
                preview = null;
                previewError = err.message;
              }
              update();
            }
          }, "\u751F\u6210\u5DEE\u5F02\u9884\u89C8")
        ),
        fileInput,
        importArea,
        previewError ? h("div", { class: "hit hit-error" }, h("span", { class: "hit-icon" }, "\u2715"), previewError) : null
      );
      el.appendChild(exportPanel);
      el.appendChild(importPanel);
      if (preview) {
        const counts = {
          exact: preview.rows.filter((r) => r.status === "exact").length,
          printing: preview.rows.filter((r) => r.status === "printing-missing").length,
          sameName: preview.rows.filter((r) => r.status === "same-name").length,
          removed: preview.rows.filter((r) => r.status === "removed").length
        };
        const previewPanel = h(
          "section",
          { class: "card-panel preview-panel" },
          h("h2", { class: "section-title" }, `\u5DEE\u5F02\u9884\u89C8\uFF1A${preview.deckName}`),
          h(
            "div",
            { class: "preview-meta muted small" },
            preview.sourcePoolVersion ? `\u5BFC\u51FA\u6765\u6E90\u5361\u6C60 ${preview.sourcePoolVersion} \u2192 ` : "",
            `\u76EE\u6807\u5361\u6C60 ${targetPool().version} ${targetPool().label}`,
            ` \xB7 \u5171 ${preview.rows.length} \u6761`,
            ` \xB7 \u5339\u914D ${counts.exact}`,
            counts.printing ? ` \xB7 \u5370\u6B21\u7F3A\u5931 ${counts.printing}` : "",
            counts.sameName ? ` \xB7 \u540C\u540D\u5F02 id ${counts.sameName}` : "",
            counts.removed ? ` \xB7 \u5B8C\u5168\u6D88\u5931 ${counts.removed}` : ""
          ),
          h(
            "div",
            { class: "preview-rows" },
            ...preview.rows.map((r) => h(
              "div",
              { class: `preview-row status-${r.status}` },
              h(
                "div",
                { class: "preview-row-main" },
                h("span", { class: "zone-chip" }, r.zone === "main" ? "\u4E3B" : "\u5907"),
                h("span", { class: "qty" }, `\xD7${r.count}`),
                h("span", { class: "card-title" }, h("span", { class: "diamond" }, "\u2666"), h("span", { class: "card-name-text" }, r.exportedName)),
                h("span", { class: "printing-pill" }, r.exportedPrintingLabel ?? r.printingId ?? "\u9ED8\u8BA4\u5370\u6B21"),
                h("span", { class: "mono tiny muted" }, r.cardId)
              ),
              h("div", { class: "preview-row-status" }, statusBadge(r), h("span", { class: "muted small" }, r.statusText)),
              h("div", { class: "preview-row-action" }, rowControls(r, update))
            ))
          ),
          h(
            "div",
            { class: "preview-confirm" },
            h("button", {
              class: "btn btn-primary",
              onclick: () => {
                const next = deckFromPreview(preview, targetPool());
                store.addDeck(next);
                importedId = next.id;
                update();
              }
            }, "\u6309\u4EE5\u4E0A\u9009\u62E9\u786E\u8BA4\u5BFC\u5165\u4E3A\u65B0\u724C\u7EC4"),
            importedId ? h(
              "span",
              { class: "ok-text" },
              "\u5DF2\u5BFC\u5165\u3002",
              h("button", { class: "link-btn", onclick: () => goTab2("decks") }, "\u524D\u5F80\u724C\u7EC4\u6821\u9A8C \u2192")
            ) : h("span", { class: "muted small" }, "\u4FDD\u6301\u7F3A\u5931\u7684\u6761\u76EE\u4F1A\u4EE5\u7EA2\u8272\u5360\u4F4D\u8FDB\u5165\u724C\u7EC4\uFF0C\u5E76\u5728\u6821\u9A8C\u4E2D\u6301\u7EED\u62A5\u9519\uFF0C\u76F4\u5230\u4F60\u624B\u52A8\u5904\u7406\u3002")
          )
        );
        el.appendChild(previewPanel);
      }
    }
    update();
    return { el, onStoreChange: update };
  }

  // src/main.ts
  var TABS = [
    { id: "decks", label: "\u2460 \u724C\u7EC4\u4E0E\u5370\u6B21\u6821\u9A8C", hint: "\u4E3B\u724C / \u5907\u9009\u3001\u5171\u4EAB\u4E0A\u9650\u3001\u6838\u5FC3\u9635\u8425" },
    { id: "exchange", label: "\u2461 \u5907\u9009\u4EA4\u6362", hint: "\u6574\u6279\u5408\u6CD5\u624D\u751F\u6548\uFF0C\u9519\u8BEF\u5F52\u56E0\u5230\u539F\u724C / \u6362\u5165\u724C" },
    { id: "opening", label: "\u2462 \u8D77\u624B\u4E0E\u6362\u624B", hint: "\u56FA\u5B9A\u79CD\u5B50\u3001\u4E00\u6B21\u8C03\u5EA6\u3001\u642D\u914D\u8D44\u683C" },
    { id: "simulate", label: "\u2463 \u79CD\u5B50\u5BF9\u6BD4", hint: "\u591A\u724C\u7EC4\u540C\u6279\u79CD\u5B50\uFF0C\u70B9\u5F00\u5931\u8D25\u6837\u672C" },
    { id: "io", label: "\u2464 \u5BFC\u5165\u5BFC\u51FA / \u7248\u672C\u5DEE\u5F02", hint: "\u8BA4 id \u4E0D\u8BA4\u540D\u5B57\uFF0C\u4E0D\u505A\u540C\u540D\u9876\u66FF" }
  ];
  var active = "decks";
  var controllers = {};
  function getController(id) {
    const existing = controllers[id];
    if (existing) return existing;
    let c;
    if (id === "exchange") c = createExchangeTab();
    else if (id === "opening") c = createOpeningTab();
    else if (id === "simulate") c = createSimulateTab();
    else if (id === "io") c = createIoTab(goTab);
    else {
      const el = h("div", { class: "tab-decks-host" });
      const update = () => {
        clear(el);
        el.appendChild(renderDecksTab());
      };
      update();
      c = { el, onStoreChange: update };
    }
    controllers[id] = c;
    return c;
  }
  function goTab(id) {
    if (TABS.some((t) => t.id === id)) switchTab(id);
  }
  function switchTab(id) {
    active = id;
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    const view = document.getElementById("view");
    clear(view);
    const c = getController(id);
    c.onStoreChange?.();
    view.appendChild(c.el);
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === id);
    });
  }
  function boot() {
    const app = document.getElementById("app");
    const nav = h(
      "nav",
      { class: "tab-nav" },
      ...TABS.map((t) => h("button", {
        class: "tab-btn",
        dataset: { tab: t.id },
        title: t.hint,
        onclick: () => switchTab(t.id)
      }, t.label))
    );
    const header = h(
      "header",
      { class: "app-header" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "brand-diamond" }, "\u2666"),
        h(
          "div",
          null,
          h("h1", null, "\u65B9\u7247\u724C\u7EC4\u5B9E\u9A8C\u5BA4"),
          h("p", { class: "brand-sub" }, "\u865A\u6784\u5361\u724C\u684C\u6E38 \xB7 \u672C\u5730\u724C\u7EC4 / \u5907\u9009\u4EA4\u6362 / \u8D77\u624B\u6821\u9A8C / \u79CD\u5B50\u6A2A\u8BC4\uFF08\u6570\u636E\u4E0D\u51FA\u6D4F\u89C8\u5668\uFF09")
        )
      ),
      h("div", { class: "header-meta" }, "TypeScript \xB7 \u5355\u6587\u4EF6\u6253\u5305 \xB7 file:// \u53EF\u5F00")
    );
    app.appendChild(header);
    app.appendChild(nav);
    app.appendChild(h("main", { id: "view", class: "view" }));
    const initial = location.hash.replace("#", "") || "decks";
    switchTab(TABS.some((t) => t.id === initial) ? initial : "decks");
    window.addEventListener("hashchange", () => {
      const id = location.hash.replace("#", "");
      if (TABS.some((t) => t.id === id) && id !== active) switchTab(id);
    });
    store.subscribe(() => {
      controllers[active]?.onStoreChange?.();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
