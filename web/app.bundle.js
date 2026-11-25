"use strict";
(() => {
  // src/ui/h.ts
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, raw] of Object.entries(attrs)) {
        if (key === "spellcheck") {
          el.setAttribute("spellcheck", String(raw));
          continue;
        }
        if (raw === void 0 || raw === null || raw === false) continue;
        if (key === "class") {
          el.className = String(raw);
        } else if (key === "dataset" && raw && typeof raw === "object") {
          for (const [dk, dv] of Object.entries(raw)) {
            el.dataset[dk] = dv;
          }
        } else if (key.startsWith("on") && typeof raw === "function") {
          el.addEventListener(key.slice(2).toLowerCase(), raw);
        } else if (key === "value" && el instanceof HTMLInputElement) {
          el.value = String(raw);
        } else if (key === "checked" && el instanceof HTMLInputElement) {
          el.checked = Boolean(raw);
        } else if (key in el && key !== "list") {
          try {
            el[key] = raw;
          } catch {
            el.setAttribute(key, String(raw));
          }
        } else {
          el.setAttribute(key, String(raw));
        }
      }
    }
    appendChildren(el, children);
    return el;
  }
  function appendChildren(el, children) {
    for (const child of children) {
      if (child === false || child === null || child === void 0) continue;
      if (Array.isArray(child)) {
        appendChildren(el, child);
      } else if (child instanceof Node) {
        el.appendChild(child);
      } else {
        el.appendChild(document.createTextNode(String(child)));
      }
    }
  }
  function clear(el) {
    el.replaceChildren();
  }
  function downloadText(filename, content, mime = "text/markdown") {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }

  // src/data/packs/zh-CN.ts
  var zhCN = {
    locale: "zh-CN",
    label: "\u7B80\u4F53\u4E2D\u6587",
    isReference: true,
    fallbackLocale: "en-US",
    terms: {
      address: {
        oldfriend: "\u8001\u670B\u53CB",
        captain: "\u56E2\u957F",
        kid: "\u5C0F\u5BB6\u4F19",
        stranger: "\u65C5\u4EBA"
      }
    },
    entries: {
      "shop.welcome": {
        id: "shop.welcome",
        description: "\u5E97\u4E3B\u8FCE\u5BA2\uFF1A\u968F\u8BF4\u8BDD\u5BF9\u8C61\uFF08\u79F0\u547C\u7C7B\u522B\uFF09\u53D8\u5316",
        params: { address: { type: "string" } },
        forms: [
          {
            when: { address: "captain" },
            text: "\u6B22\u8FCE\u56DE\u6765\uFF0C{address}\uFF01\u7801\u5934\u7684\u98CE\u6CA1\u5C11\u5439\u60A8\u5427\u3002",
            note: "\u5BF9\u9A91\u58EB\u56E2\u957F\u7528\u656C\u8BED"
          },
          {
            when: { address: "kid" },
            text: "\u54DF\uFF0C{address}\uFF01\u4ECA\u5929\u6512\u4E86\u591A\u5C11\u94DC\u5E01\u5440\uFF1F"
          },
          {
            when: { address: "stranger" },
            text: "\u521D\u6B21\u89C1\u9762\uFF0C{address}\u3002\u6E2F\u91CC\u591C\u91CC\u51C9\uFF0C\u5148\u770B\u4EF6\u539A\u5B9E\u7684\uFF1F"
          },
          {
            when: {},
            text: "\u4F60\u6765\u5566\uFF0C{address}\u3002\u968F\u4FBF\u770B\uFF0C\u522B\u78B0\u5012\u67B6\u5B50\u5C31\u884C\u3002"
          }
        ]
      },
      "shop.buy": {
        id: "shop.buy",
        description: "\u8D2D\u4E70\u6210\u529F\uFF1A\u6570\u91CF + \u7269\u54C1\u7C7B\u522B\uFF08\u4E2D\u6587\u91CF\u8BCD\uFF09\u5171\u540C\u51B3\u5B9A\u53E5\u5F0F",
        params: { count: { type: "integer" }, item: { type: "string" } },
        forms: [
          { when: { count: "zero" }, text: "\u4F60\u6446\u4E86\u6446\u624B\uFF0C\u8FD9\u6B21\u4EC0\u4E48\u4E5F\u6CA1\u4E70\u3002" },
          {
            when: { count: "one", category: "potion" },
            text: "\u4F60\u4E70\u4E0B {count} \u74F6\u300C{item}\u300D\uFF0C\u585E\u8FDB\u80CC\u5305\u4FA7\u888B\u3002"
          },
          {
            when: { count: "one", category: "weapon" },
            text: "\u4F60\u4E70\u4E0B {count} \u628A\u300C{item}\u300D\uFF0C\u62D4\u5251\u58F0\u5F15\u5F97\u6EE1\u9152\u9986\u56DE\u5934\u3002"
          },
          {
            when: { count: "one" },
            text: "\u4F60\u4E70\u4E0B {count} \u4E2A\u300C{item}\u300D\uFF0C\u82D4\u59E8\u987A\u624B\u591A\u585E\u6765\u4E00\u5F20\u6298\u6263\u5238\u3002"
          },
          {
            when: { count: "other", category: "potion" },
            text: "\u4F60\u4E70\u4E0B {count} \u74F6\u300C{item}\u300D\uFF0C\u74F6\u74F6\u7F50\u7F50\u5728\u5305\u91CC\u53EE\u5F53\u4F5C\u54CD\u3002"
          },
          {
            when: { count: "other", category: "weapon" },
            text: "\u4F60\u4E70\u4E0B {count} \u628A\u300C{item}\u300D\uFF0C\u6D3B\u50CF\u4E2A\u884C\u8D70\u7684\u5175\u5668\u67B6\u3002"
          },
          {
            when: { count: "other" },
            text: "\u4F60\u4E70\u4E0B {count} \u4E2A\u300C{item}\u300D\uFF0C\u82D4\u59E8\u7B11\u5F97\u773C\u775B\u772F\u6210\u4E00\u6761\u7F1D\u3002"
          }
        ]
      },
      "item.inspect": {
        id: "item.inspect",
        description: "\u9053\u5177\u8BF4\u660E/\u67E5\u770B\u6301\u6709\u6570\uFF1A\u540C\u65F6\u5305\u542B\u79F0\u547C\u3001\u7269\u54C1\u540D\u4E0E\u6570\u91CF\u53D8\u91CF",
        params: {
          address: { type: "string" },
          item: { type: "string" },
          count: { type: "integer" }
        },
        forms: [
          {
            when: { count: "zero" },
            text: "{address}\uFF0C\u300C{item}\u300D\u5DF2\u7ECF\u4E00\u4EF6\u4E0D\u5269\u4E86\u3002"
          },
          {
            when: { count: "one" },
            text: "{address}\uFF0C\u300C{item}\u300D\u53EA\u5269 {count} \u4EF6\uFF0C\u7701\u7740\u70B9\u7528\u3002"
          },
          {
            when: { count: "other" },
            text: "{address}\uFF0C\u300C{item}\u300D\u8FD8\u5269 {count} \u4EF6\uFF0C\u8865\u7ED9\u5145\u8DB3\u3002"
          }
        ]
      },
      "quest.remind": {
        id: "quest.remind",
        description: "\u4EFB\u52A1\u63D0\u9192\uFF1A\u79F0\u547C\u3001\u62A5\u916C\u4E0E\u78B0\u9762\u5730\u70B9\u53D8\u91CF",
        params: {
          address: { type: "string" },
          reward: { type: "string" },
          place: { type: "string" }
        },
        forms: [
          {
            when: { address: "captain" },
            text: "{address}\uFF0C\u522B\u5FD8\u4E86\uFF1A\u5E26\u7740{reward}\u5230{place}\u6C47\u5408\uFF0C\u6E2F\u52A1\u957F\u53EF\u4E0D\u7B49\u4EBA\u3002"
          },
          {
            when: {},
            text: "\u522B\u5FD8\u4E86\uFF0C\u5E26\u4E0A{reward}\u53BB{place}\u627E\u8001\u8235\u624B\u3002"
          }
        ]
      },
      "quest.reward": {
        id: "quest.reward",
        description: "\u59D4\u6258\u7ED3\u7B97\uFF1A\u91D1\u5E01\u6570\u989D\u5FC5\u987B\u662F\u6574\u6570",
        params: { reward: { type: "string" }, amount: { type: "integer" } },
        forms: [
          {
            when: {},
            text: "\u59D4\u6258\u5B8C\u6210\uFF01\u62A5\u916C\u662F {amount} \u679A\u91D1\u5E01\uFF0C\u5916\u52A0\u300C{reward}\u300D\u3002"
          }
        ]
      },
      "system.save_hint": {
        id: "system.save_hint",
        description: "\u5B58\u6863\u63D0\u793A\uFF08\u65E0\u53D8\u91CF\uFF0C\u7528\u6765\u6F14\u793A\u6574\u6761\u76EE\u8DE8\u8BED\u8A00\u56DE\u9000\uFF09",
        forms: [
          { when: {}, text: "\u98CE\u706F\u4EAE\u8D77\u65F6\uFF0C\u661F\u6E2F\u4F1A\u66FF\u4F60\u8BB0\u4F4F\u8FD9\u6B21\u8FDC\u822A\u3002" }
        ]
      },
      "shop.secret": {
        id: "shop.secret",
        description: "\u6697\u53F7\uFF1A\u5FC5\u987B\u63D0\u4F9B code \u53D8\u91CF\uFF08\u7528\u6765\u6F14\u793A\u4E8B\u4EF6\u6F0F\u4F20\u53D8\u91CF\u503C\uFF09",
        params: { code: { type: "string" } },
        forms: [
          { when: {}, text: "\u82D4\u59E8\u538B\u4F4E\u58F0\u97F3\uFF1A\u300C\u4ECA\u665A\u7684\u6697\u53F7\u662F {code}\uFF0C\u522B\u544A\u8BC9\u522B\u4EBA\u3002\u300D" }
        ]
      }
    }
  };

  // src/data/packs/en-US.ts
  var enUS = {
    locale: "en-US",
    label: "English",
    fallbackLocale: "zh-CN",
    terms: {
      address: {
        oldfriend: "old friend",
        captain: "Captain",
        kid: "kiddo",
        stranger: "traveler"
      }
    },
    entries: {
      "shop.welcome": {
        id: "shop.welcome",
        description: "Shop greeting by addressee",
        forms: [
          {
            when: { address: "captain" },
            text: "Welcome back, {address}! The docks wind has not been kind to you."
          },
          {
            when: { address: "kid" },
            text: "Hey {address}! How many coppers did you scrape together today?"
          },
          {
            when: { address: "stranger" },
            text: "First time in our harbor, {address}? Nights are cold here \u2014 something warm?"
          },
          {
            // 故意埋缺陷：基准通用句使用 {address}，这句译文把变量漏了
            when: {},
            text: "There you are. Browse around \u2014 just do not knock over the shelves."
          }
        ]
      },
      "shop.buy": {
        id: "shop.buy",
        description: "Purchase success: count + item category",
        forms: [
          { when: { count: "zero" }, text: "You wave Moss off and buy nothing this time." },
          {
            when: { count: "one", category: "potion" },
            text: "You buy {count} bottle of {item} and tuck it into your pack."
          },
          {
            when: { count: "one", category: "weapon" },
            text: "You buy {count} blade called {item}; the tavern turns to look."
          },
          {
            when: { count: "one" },
            text: "You buy {count} unit of {item}; Moss slips you a discount token."
          },
          {
            when: { count: "other", category: "potion" },
            text: "You buy {count} bottles of {item}, clinking in your pack."
          },
          {
            when: { count: "other", category: "weapon" },
            text: "You buy {count} blades of {item} \u2014 a walking armoury."
          },
          {
            when: { count: "other" },
            text: "You buy {count} \xD7 {item}. Moss beams."
          }
        ]
      },
      "item.inspect": {
        id: "item.inspect",
        description: "Item inspection with address, name and remaining count",
        forms: [
          { when: { count: "zero" }, text: "{address}, you are all out of {item}." },
          {
            when: { count: "one" },
            text: "{address}, only {count} {item} left \u2014 use it wisely."
          },
          {
            when: { count: "other" },
            text: "{address}, you still have {count} \xD7 {item} in your pack."
          }
        ]
      },
      "quest.remind": {
        id: "quest.remind",
        description: "Quest reminder",
        forms: [
          {
            when: { address: "captain" },
            // 故意埋缺陷：{placee} 是拼写错误的“多出变量”，同时漏掉了基准里的 {place}
            text: "{address}, do not forget: bring the {reward} and meet at {placee}. The harbormaster never waits."
          },
          {
            when: {},
            text: "Do not forget: bring the {reward} and meet the old helmsman at {place}."
          }
        ]
      },
      "quest.reward": {
        id: "quest.reward",
        description: "Quest settlement",
        forms: [
          { when: {}, text: "Contract complete! Reward: {amount} coins and \u201C{reward}\u201D." }
        ]
      },
      "system.save_hint": {
        id: "system.save_hint",
        description: "Save hint",
        forms: [
          { when: {}, text: "When the harbor lanterns light, Star Port remembers your voyage." }
        ]
      },
      "shop.secret": {
        id: "shop.secret",
        description: "Secret code line",
        forms: [
          { when: {}, text: "Moss whispers: \u201CTonight\u2019s code is {code}. Tell nobody.\u201D" }
        ]
      }
    }
  };

  // src/data/packs/ja-JP.ts
  var jaJP = {
    locale: "ja-JP",
    label: "\u65E5\u672C\u8A9E",
    fallbackLocale: "en-US",
    terms: {
      address: {
        oldfriend: "\u65E7\u53CB",
        captain: "\u56E3\u9577",
        kid: "\u307C\u3046\u3084",
        stranger: "\u65C5\u4EBA\u3055\u3093"
      }
    },
    entries: {
      "shop.welcome": {
        id: "shop.welcome",
        description: "\u5E97\u4E3B\u306E\u6328\u62F6\uFF1A\u547C\u3073\u304B\u3051\u76F8\u624B\u3067\u5909\u5316",
        forms: [
          {
            when: { address: "captain" },
            text: "\u304A\u5E30\u308A\u306A\u3055\u3044\u3001{address}\u3002\u6CE2\u6B62\u5834\u306E\u98A8\u306F\u5F37\u304B\u3063\u305F\u3067\u3057\u3087\u3046\u3002"
          },
          // 故意缺少 kid 专用句式：milo 触发时按约定落到 {} 通用句，来源会注明
          {
            when: {},
            text: "\u3044\u3089\u3063\u3057\u3083\u3044\u3001{address}\u3002\u68DA\u3092\u5012\u3055\u306A\u3051\u308C\u3070\u3001\u3086\u3063\u304F\u308A\u898B\u3066\u3044\u3063\u3066\u3002"
          }
        ]
      },
      "shop.buy": {
        id: "shop.buy",
        description: "\u8CFC\u5165\u6210\u529F\uFF1A\u6570\u91CF\u3068\u54C1\u7269\u30AB\u30C6\u30B4\u30EA\uFF08\u52A9\u6570\u8A5E\uFF09",
        forms: [
          { when: { count: "zero" }, text: "\u4F55\u3082\u8CB7\u308F\u305A\u306B\u624B\u3092\u632F\u3063\u305F\u3002" },
          {
            when: { count: "one", category: "potion" },
            text: "\u300C{item}\u300D\u3092 {count} \u672C\u8CB7\u3044\u3001\u9784\u306E\u6A2A\u30DD\u30B1\u30C3\u30C8\u306B\u3057\u307E\u3063\u305F\u3002"
          },
          {
            when: { count: "one", category: "weapon" },
            text: "\u300C{item}\u300D\u3092 {count} \u632F\u308A\u8CB7\u3046\u3068\u3001\u9152\u5834\u4E2D\u306E\u8996\u7DDA\u304C\u96C6\u307E\u3063\u305F\u3002"
          },
          // 故意没有 one 通用句：food/material 在 1 个时回退到 other 通用句
          {
            when: { count: "other", category: "potion" },
            text: "\u300C{item}\u300D\u3092 {count} \u672C\u8CB7\u3044\u8FBC\u307F\u3001\u74F6\u304C\u9784\u306E\u4E2D\u3067\u30AB\u30BF\u30AB\u30BF\u9CF4\u308B\u3002"
          },
          {
            when: { count: "other", category: "weapon" },
            text: "\u300C{item}\u300D\u3092 {count} \u632F\u308A\u63C3\u3048\u3001\u307E\u308B\u3067\u79FB\u52D5\u6B66\u5668\u5C4B\u3060\u3002"
          },
          {
            when: { count: "other" },
            text: "\u300C{item}\u300D\u3092 {count} \u500B\u8CB7\u3063\u305F\u3002\u82D4\u304A\u3070\u306F\u76EE\u3092\u7D30\u3081\u3066\u7B11\u3046\u3002"
          }
        ]
      },
      "item.inspect": {
        id: "item.inspect",
        description: "\u30A2\u30A4\u30C6\u30E0\u8AAC\u660E\uFF1A\u547C\u79F0\u30FB\u540D\u524D\u30FB\u6B8B\u308A\u6570",
        forms: [
          { when: { count: "zero" }, text: "{address}\u3001\u300C{item}\u300D\u306F\u3082\u3046\u4E00\u3064\u3082\u6B8B\u3063\u3066\u3044\u306A\u3044\u3088\u3002" },
          {
            when: { count: "one" },
            text: "{address}\u3001\u300C{item}\u300D\u306F\u3042\u3068 {count} \u500B\u3060\u3088\u3002\u5927\u4E8B\u306B\u4F7F\u3063\u3066\u3002"
          },
          {
            when: { count: "other" },
            // 故意埋缺陷：基准 other 句にある {count} を翻訳が入れ忘れている
            text: "{address}\u3001\u300C{item}\u300D\u306F\u307E\u3060\u305F\u3063\u3077\u308A\u6B8B\u3063\u3066\u3044\u308B\u3088\u3002"
          }
        ]
      },
      // 故意整个缺少 quest.remind 条目 -> 试玩时跨语言回退到 en-US，徽章必须标明
      "quest.reward": {
        id: "quest.reward",
        description: "\u30AF\u30A8\u30B9\u30C8\u5831\u916C",
        forms: [
          { when: {}, text: "\u4F9D\u983C\u9054\u6210\uFF01 \u5831\u916C\u306F\u91D1\u8CA8 {amount} \u679A\u3068\u300C{reward}\u300D\u3060\u3002" }
        ]
      },
      // 故意缺少 system.save_hint -> 干净的 en-US 回退例
      "shop.secret": {
        id: "shop.secret",
        description: "\u5408\u8A00\u8449",
        forms: [
          { when: {}, text: "\u82D4\u304A\u3070\u306F\u58F0\u3092\u3072\u305D\u3081\u305F\u3002\u300C\u4ECA\u591C\u306E\u5408\u8A00\u8449\u306F {code} \u3060\u3088\u3002\u8AB0\u306B\u3082\u8A00\u3046\u3093\u3058\u3083\u306A\u3044\u300D" }
        ]
      }
    }
  };

  // src/data/packs/index.ts
  var BASELINE_PACKS = {
    "zh-CN": zhCN,
    "en-US": enUS,
    "ja-JP": jaJP
  };
  var REFERENCE_LOCALE = "zh-CN";
  var LOCALE_ORDER = ["zh-CN", "en-US", "ja-JP"];
  function clonePacks(packs) {
    return JSON.parse(JSON.stringify(packs));
  }

  // src/data/game-data.ts
  var CHARACTERS = [
    {
      id: "lynn",
      address: "oldfriend",
      name: { "zh-CN": "\u6797\u6069", "en-US": "Lynn", "ja-JP": "\u30EA\u30F3" }
    },
    {
      id: "vera",
      address: "captain",
      name: { "zh-CN": "\u8587\u62C9", "en-US": "Vera", "ja-JP": "\u30F4\u30A7\u30E9" }
    },
    {
      id: "milo",
      address: "kid",
      name: { "zh-CN": "\u7C73\u6D1B", "en-US": "Milo", "ja-JP": "\u30DE\u30A4\u30ED" }
    },
    {
      id: "shade",
      address: "stranger",
      name: { "zh-CN": "\u515C\u5E3D\u5BA2", "en-US": "Shade", "ja-JP": "\u30B7\u30A7\u30A4\u30C9" }
    }
  ];
  var CHARACTERS_BY_ID = Object.fromEntries(
    CHARACTERS.map((c) => [c.id, c])
  );
  var ITEMS = [
    {
      id: "moon_tonic",
      category: "potion",
      name: { "zh-CN": "\u6708\u9732\u836F\u6C34", "en-US": "Moondew Tonic", "ja-JP": "\u6708\u306E\u96EB\u85AC" }
    },
    {
      id: "ember_blade",
      category: "weapon",
      name: { "zh-CN": "\u4F59\u70EC\u77ED\u5203", "en-US": "Ember Dagger", "ja-JP": "\u6B8B\u706B\u306E\u77ED\u5263" }
    },
    {
      id: "berry_bun",
      category: "food",
      name: { "zh-CN": "\u9EA6\u9999\u679C\u5305", "en-US": "Berry Bun", "ja-JP": "\u30D9\u30EA\u30FC\u307E\u3093" }
    },
    {
      id: "crystal_shard",
      category: "material",
      name: { "zh-CN": "\u5171\u9E23\u6676\u7C07", "en-US": "Resonant Shard", "ja-JP": "\u5171\u9CF4\u7D50\u6676" }
    }
  ];
  var ITEMS_BY_ID = Object.fromEntries(
    ITEMS.map((i) => [i.id, i])
  );
  var SPEAKERS = {
    moss: { "zh-CN": "\u82D4\u59E8", "en-US": "Aunt Moss", "ja-JP": "\u82D4\u304A\u3070" },
    narrator: { "zh-CN": "\u65C1\u767D", "en-US": "Narrator", "ja-JP": "\u30CA\u30EC\u30FC\u30B7\u30E7\u30F3" }
  };
  var CATEGORY_LABEL = {
    "zh-CN": { potion: "\u836F\u6C34", weapon: "\u6B66\u5668", food: "\u98DF\u7269", material: "\u6750\u6599" },
    "en-US": { potion: "potion", weapon: "weapon", food: "food", material: "material" },
    "ja-JP": { potion: "\u85AC", weapon: "\u6B66\u5668", food: "\u98DF\u3079\u7269", material: "\u7D20\u6750" }
  };
  function categoryLabel(category, locale) {
    return CATEGORY_LABEL[locale]?.[category] ?? CATEGORY_LABEL["zh-CN"][category] ?? category;
  }

  // src/core/plural.ts
  function pluralCategory(locale, n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "other";
    if (n === 0) return "zero";
    if (n === 1) return "one";
    const l = locale.toLowerCase();
    if (l.startsWith("en")) return "other";
    if (l.startsWith("zh") || l.startsWith("ja") || l.startsWith("ko")) return "other";
    return "other";
  }
  function countBucketFallback(order) {
    switch (order) {
      case "zero":
        return ["zero", "other"];
      case "one":
        return ["one", "other"];
      case "two":
        return ["two", "few", "other"];
      case "few":
        return ["few", "other"];
      case "many":
        return ["many", "other"];
      default:
        return ["other"];
    }
  }
  function exampleCountForBucket(bucket) {
    switch (bucket) {
      case "zero":
        return 0;
      case "one":
        return 1;
      case "two":
        return 2;
      case "few":
        return 3;
      case "many":
        return 9;
      case "other":
        return 5;
      default:
        return void 0;
    }
  }

  // src/core/context.ts
  function localizedName(names, locale) {
    return names[locale] ?? names["zh-CN"] ?? Object.values(names)[0] ?? "";
  }
  function lv(values) {
    return { $localized: values };
  }
  function resolveVar(value, locale) {
    if (value && typeof value === "object" && "$localized" in value) {
      const map = value.$localized;
      return map[locale] ?? map["zh-CN"] ?? Object.values(map)[0] ?? "";
    }
    return value;
  }
  function buildContext(sample, locale, pack, characters, items) {
    const values = {};
    for (const [k, v] of Object.entries(sample.vars ?? {})) {
      values[k] = resolveVar(v, locale);
    }
    const match = {};
    if (typeof sample.count === "number") {
      values.count = sample.count;
      match.countBucket = pluralCategory(locale, sample.count);
    }
    let character;
    if (sample.characterId) {
      character = characters[sample.characterId];
      if (character) {
        match.address = character.address;
        values.address = pack.terms.address[character.address] ?? character.address;
        values.name = localizedName(character.name, locale);
      }
    }
    let item;
    if (sample.itemId) {
      item = items[sample.itemId];
      if (item) {
        match.category = item.category;
        values.item = localizedName(item.name, locale);
        values.category = item.category;
      }
    }
    return { match, values, character, item };
  }

  // src/data/events.ts
  function makeEvent(id, title, blurb, lines) {
    return {
      id,
      title,
      blurb,
      lines: lines.map((l) => ({
        id: l.id,
        speakerId: l.speaker,
        sample: {
          ...l.sample,
          id: l.sample.id ?? `${id}.${l.id}`,
          eventId: id,
          lineId: l.id
        }
      }))
    };
  }
  var COMPASS = lv({
    "zh-CN": "\u6F6E\u6C50\u7F57\u76D8",
    "en-US": "Tide Compass",
    "ja-JP": "\u6F6E\u306E\u7F85\u91DD\u76E4"
  });
  var LIGHTHOUSE = lv({
    "zh-CN": "\u65E7\u706F\u5854",
    "en-US": "the Old Lighthouse",
    "ja-JP": "\u65E7\u706F\u53F0"
  });
  var BADGE = lv({
    "zh-CN": "\u94F6\u6E2F\u5FBD\u7AE0",
    "en-US": "Silver Harbor Badge",
    "ja-JP": "\u9280\u6E2F\u30D0\u30C3\u30B8"
  });
  var EVENTS = [
    makeEvent("ev_harbor", "\u521D\u5230\u661F\u6E2F", "\u6797\u6069\u7B2C\u4E00\u6B21\u8D70\u8FDB\u82D4\u59E8\u7684\u6742\u8D27\u94FA\u3002", [
      {
        id: "welcome",
        speaker: "moss",
        sample: {
          label: "\u6797\u6069\uFF08\u8001\u670B\u53CB\u79F0\u547C\uFF09\u8FDB\u5E97",
          entryId: "shop.welcome",
          characterId: "lynn"
        }
      },
      {
        id: "inspect",
        speaker: "narrator",
        sample: {
          label: "\u67E5\u770B\u6708\u9732\u836F\u6C34\uFF0C\u6301\u6709 2 \u74F6",
          entryId: "item.inspect",
          characterId: "lynn",
          itemId: "moon_tonic",
          count: 2
        }
      },
      {
        id: "save_hint",
        speaker: "narrator",
        sample: {
          label: "\u98CE\u8D77\u65F6\u7684\u5B58\u6863\u63D0\u793A",
          entryId: "system.save_hint"
        }
      }
    ]),
    makeEvent("ev_deal", "\u7B2C\u4E00\u7B14\u4E70\u5356", "\u4E0D\u540C\u5BA2\u4EBA\u3001\u7269\u54C1\u7C7B\u522B\u548C\u6570\u91CF\u4E0B\u7684\u6210\u4EA4\u53E5\u3002", [
      {
        id: "blade_one",
        speaker: "moss",
        sample: {
          label: "\u8587\u62C9\u56E2\u957F\u4E70 1 \u628A\u4F59\u70EC\u77ED\u5203",
          entryId: "shop.buy",
          characterId: "vera",
          itemId: "ember_blade",
          count: 1
        }
      },
      {
        id: "bun_zero",
        speaker: "moss",
        sample: {
          label: "\u7C73\u6D1B\u4E70\u9EA6\u9999\u679C\u5305\uFF0C\u6570\u91CF 0",
          entryId: "shop.buy",
          characterId: "milo",
          itemId: "berry_bun",
          count: 0
        }
      },
      {
        id: "tonic_three",
        speaker: "moss",
        sample: {
          label: "\u6797\u6069\u4E70 3 \u74F6\u6708\u9732\u836F\u6C34",
          entryId: "shop.buy",
          characterId: "lynn",
          itemId: "moon_tonic",
          count: 3
        }
      },
      {
        id: "shard_five",
        speaker: "moss",
        sample: {
          label: "\u8587\u62C9\u4E70 5 \u4E2A\u5171\u9E23\u6676\u7C07",
          entryId: "shop.buy",
          characterId: "vera",
          itemId: "crystal_shard",
          count: 5
        }
      }
    ]),
    makeEvent("ev_quest", "\u56E2\u957F\u7684\u59D4\u6258", "\u4EFB\u52A1\u63D0\u9192\u4E0E\u7ED3\u7B97\uFF0C\u542B\u591A\u53D8\u91CF\u4E0E\u4E00\u4E2A\u9648\u65E7\u8C03\u8BD5\u53D8\u91CF\u3002", [
      {
        id: "remind",
        speaker: "moss",
        sample: {
          label: "\u7528\u56E2\u957F\u79F0\u547C\u63D0\u9192\u6C47\u5408\u5730\u70B9",
          entryId: "quest.remind",
          characterId: "vera",
          vars: {
            reward: COMPASS,
            place: LIGHTHOUSE,
            qa_note: "regression-sample-3"
          }
        }
      },
      {
        id: "reward_ok",
        speaker: "moss",
        sample: {
          label: "\u6B63\u5E38\u7ED3\u7B97\uFF1A30 \u679A\u91D1\u5E01\uFF08\u6574\u6570\uFF09",
          entryId: "quest.reward",
          characterId: "lynn",
          vars: { reward: BADGE, amount: 30 }
        }
      }
    ]),
    makeEvent(
      "ev_broken",
      "\u8D28\u68C0\u4E8B\u6545\u73B0\u573A",
      "\u4E2D\u95F4\u4E24\u53E5\u5206\u522B\u6709\u7C7B\u578B\u9519\u8BEF\u548C\u6F0F\u4F20\u53D8\u91CF\uFF0C\u524D\u540E\u53F0\u8BCD\u5FC5\u987B\u7167\u5E38\u6E32\u67D3\u3002",
      [
        {
          id: "before",
          speaker: "moss",
          sample: {
            label: "\u574F\u6837\u4F8B\u4E4B\u524D\u7684\u95EE\u5019\uFF08\u5E94\u6B63\u5E38\uFF09",
            entryId: "shop.welcome",
            characterId: "milo"
          }
        },
        {
          id: "bad_type",
          speaker: "moss",
          sample: {
            label: "\u91D1\u5E01\u6570\u4F20\u6210\u4E86\u4E2D\u6587\u5B57\u7B26\u4E32\u201C\u4E09\u201D",
            entryId: "quest.reward",
            characterId: "milo",
            vars: { reward: BADGE, amount: "\u4E09" }
          }
        },
        {
          id: "missing_value",
          speaker: "moss",
          sample: {
            label: "\u6697\u53F7\u4E8B\u4EF6\u6F0F\u4F20 code \u53D8\u91CF",
            entryId: "shop.secret",
            characterId: "vera",
            vars: {}
          }
        },
        {
          id: "after",
          speaker: "moss",
          sample: {
            label: "\u574F\u6837\u4F8B\u4E4B\u540E\u7684\u6210\u4EA4\u53E5\uFF08\u5E94\u6B63\u5E38\uFF09",
            entryId: "shop.buy",
            characterId: "lynn",
            itemId: "moon_tonic",
            count: 2
          }
        }
      ]
    )
  ];
  var EVENT_SAMPLES = EVENTS.flatMap((e) => e.lines.map((l) => l.sample));
  var MATRIX_COUNTS = [0, 1, 2, 5];
  function matrixSamplesFor(entryId) {
    return ITEMS.flatMap(
      (item) => MATRIX_COUNTS.map((count) => ({
        id: `mx-${entryId === "shop.buy" ? "buy" : "inspect"}-${item.id}-${count}`,
        eventId: "ev_matrix",
        lineId: `mx-${item.id}-${count}`,
        label: `${item.id} \xD7 ${count}`,
        entryId,
        characterId: "lynn",
        itemId: item.id,
        count
      }))
    );
  }
  var BUY_MATRIX_SAMPLES = matrixSamplesFor("shop.buy");
  var INSPECT_MATRIX_SAMPLES = matrixSamplesFor("item.inspect");
  var MATRIX_SAMPLES = [...BUY_MATRIX_SAMPLES, ...INSPECT_MATRIX_SAMPLES];
  var ALL_SAMPLES = [...EVENT_SAMPLES, ...MATRIX_SAMPLES];

  // src/core/template.ts
  var PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  function extractPlaceholders(text) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    return out;
  }
  function typeMatches(spec, value) {
    if (value === null || value === void 0) return false;
    switch (spec) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      default:
        return true;
    }
  }
  function stringifyValue(value) {
    if (value === null || value === void 0) return "";
    return String(value);
  }
  function renderTemplate(text, values, params) {
    const parts = [];
    let plain = "";
    let last = 0;
    PLACEHOLDER_RE.lastIndex = 0;
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      const idx = match.index ?? 0;
      if (idx > last) {
        const t = text.slice(last, idx);
        parts.push({ type: "text", value: t });
        plain += t;
      }
      const name = match[1];
      const has = Object.prototype.hasOwnProperty.call(values, name);
      const raw = values[name];
      if (!has || raw === void 0 || raw === null || raw === "") {
        const shown = `\u27E8\u7F3A\u5931:${name}\u27E9`;
        parts.push({ type: "var", value: match[0], varName: name, state: "missing", shown });
        plain += shown;
      } else {
        const spec = params?.[name];
        const badType = spec ? !typeMatches(spec.type, raw) : false;
        const shown = stringifyValue(raw);
        parts.push({
          type: "var",
          value: match[0],
          varName: name,
          state: badType ? "bad-type" : "ok",
          shown
        });
        plain += shown;
      }
      last = idx + match[0].length;
    }
    if (last < text.length) {
      const t = text.slice(last);
      parts.push({ type: "text", value: t });
      plain += t;
    }
    return { parts, text: plain };
  }
  function whenSignature(when) {
    if (!when) return "\u2205";
    const bits = [];
    if (when.count !== void 0) bits.push(`count=${when.count}`);
    if (when.address !== void 0) bits.push(`address=${when.address}`);
    if (when.category !== void 0) bits.push(`category=${when.category}`);
    return bits.length ? bits.join("&") : "*";
  }
  function whenLabel(when) {
    if (!when) return "\u65E0\u6761\u4EF6\u901A\u7528\u53E5";
    const bits = [];
    if (when.count) bits.push(`\u6570\u91CF=${when.count}`);
    if (when.address) bits.push(`\u79F0\u547C=${when.address}`);
    if (when.category) bits.push(`\u7C7B\u522B=${when.category}`);
    return bits.length ? bits.join("\uFF0C") : "\u65E0\u6761\u4EF6\u901A\u7528\u53E5";
  }

  // src/core/resolve.ts
  function resolveWithin(pack, entryId, ctx2) {
    const entry = pack.entries[entryId];
    if (!entry) return null;
    const bucketOrder = ctx2.countBucket ? countBucketFallback(ctx2.countBucket) : void 0;
    let best;
    entry.forms.forEach((form, index) => {
      const w2 = form.when ?? {};
      if (w2.address && w2.address !== ctx2.address) return;
      if (w2.category && w2.category !== ctx2.category) return;
      let countRank;
      if (w2.count) {
        if (!bucketOrder) return;
        const idx = bucketOrder.indexOf(w2.count);
        if (idx === -1) return;
        countRank = idx;
      } else {
        countRank = bucketOrder ? bucketOrder.length : 0;
      }
      const specificity = Object.keys(w2).length;
      if (!best || countRank < best.countRank || countRank === best.countRank && specificity > best.specificity || countRank === best.countRank && specificity === best.specificity && index < best.index) {
        best = { index, form, countRank, specificity };
      }
    });
    if (!best) return null;
    const chosen = best;
    const w = chosen.form.when ?? {};
    const hops = [];
    const entryUses = {
      count: entry.forms.some((f) => f.when?.count !== void 0),
      address: entry.forms.some((f) => f.when?.address !== void 0),
      category: entry.forms.some((f) => f.when?.category !== void 0)
    };
    let via = "exact";
    if (ctx2.countBucket && entryUses.count && w.count !== ctx2.countBucket) {
      via = "count-fallback";
      if (!w.count) {
        hops.push(`\u7F3A\u5C11 ${ctx2.countBucket} \u6570\u91CF\u5F0F\uFF0C\u6309\u7EA6\u5B9A\u6539\u7528\u4E0D\u9650\u6570\u91CF\u7684\u901A\u7528\u53E5`);
      } else {
        hops.push(`\u7F3A\u5C11 ${ctx2.countBucket} \u6570\u91CF\u5F0F\uFF0C\u6309\u7EA6\u5B9A\u56DE\u9000\u5230 ${w.count} \u53E5\u5F0F`);
      }
    }
    const relaxed = [];
    if (entryUses.address && ctx2.address && w.address !== ctx2.address)
      relaxed.push(`\u79F0\u547C=${ctx2.address} \u65E0\u4E13\u7528\u53E5\uFF0C\u843D\u5230\u901A\u7528\u79F0\u547C\u53E5`);
    if (entryUses.category && ctx2.category && w.category !== ctx2.category)
      relaxed.push(`\u7C7B\u522B=${ctx2.category} \u65E0\u4E13\u7528\u53E5\uFF0C\u843D\u5230\u901A\u7528\u7C7B\u522B\u53E5`);
    if (relaxed.length) {
      if (via === "exact") via = "generic-form";
      hops.push(...relaxed);
    }
    return { form: chosen.form, index: chosen.index, countRank: chosen.countRank, via, hops };
  }
  function sourceLabel(locale, entryId, when) {
    return `${locale} / ${entryId} # ${whenSignature(when)}`;
  }
  function resolveWithFallback(packs, locale, entryId, ctx2) {
    const hops = [];
    const visited = /* @__PURE__ */ new Set();
    let currentLocale = locale;
    let crossLanguage = false;
    while (currentLocale && !visited.has(currentLocale)) {
      visited.add(currentLocale);
      const pack = packs[currentLocale];
      if (!pack) {
        hops.push(`\u8BED\u8A00\u5305 ${currentLocale} \u4E0D\u5B58\u5728`);
        currentLocale = packs[locale]?.fallbackLocale;
        continue;
      }
      const hasEntry = Boolean(pack.entries[entryId]);
      const within = resolveWithin(pack, entryId, ctx2);
      if (within) {
        const w = within.form.when ?? {};
        hops.push(...within.hops);
        const isFallback = crossLanguage || within.via !== "exact";
        const via = crossLanguage ? "locale-fallback" : within.via === "exact" ? "exact" : within.via;
        return {
          text: within.form.text,
          pack,
          source: {
            locale: currentLocale,
            entryId,
            when: w,
            formIndex: within.index,
            via,
            isFallback,
            hops: hops.filter(Boolean),
            signature: `${currentLocale}::${entryId}#${whenSignature(w)}`,
            label: sourceLabel(currentLocale, entryId, w)
          }
        };
      }
      hops.push(
        hasEntry ? `${currentLocale} / ${entryId} \u6CA1\u6709\u6EE1\u8DB3\u5F53\u524D\u4E0A\u4E0B\u6587\u7684\u53E5\u5F0F` : `${currentLocale} \u7F3A\u5C11\u6761\u76EE ${entryId}`
      );
      crossLanguage = true;
      if (pack.fallbackLocale) hops.push(`\u6309\u7EA6\u5B9A\u8DE8\u8BED\u8A00\u56DE\u9000\u5230 ${pack.fallbackLocale}`);
      currentLocale = pack.fallbackLocale;
    }
    return {
      text: `\u27E8\u672A\u627E\u5230\u6587\u6848 ${entryId}\u27E9`,
      pack: null,
      source: {
        locale,
        entryId,
        when: null,
        formIndex: -1,
        via: "missing",
        isFallback: true,
        hops,
        signature: `missing::${entryId}`,
        label: `\u7F3A\u5931 / ${entryId}`
      }
    };
  }

  // src/core/checks.ts
  function triggerOf(sample) {
    const t = {};
    if (sample.characterId) t.characterId = sample.characterId;
    if (sample.itemId) t.itemId = sample.itemId;
    if (typeof sample.count === "number") t.count = sample.count;
    if (sample.vars && Object.keys(sample.vars).length) t.vars = sample.vars;
    return t;
  }
  function baseIssue(partial, sample) {
    return {
      sampleId: sample.id,
      sampleLabel: sample.label,
      eventId: sample.eventId,
      trigger: triggerOf(sample),
      ...partial
    };
  }
  function suggestTrigger(when, characters, items, siblingWhens = []) {
    const parts = [];
    const w = when ?? {};
    if (w.count) {
      const count = exampleCountForBucket(w.count);
      if (count !== void 0) parts.push(`count=${count}`);
    }
    if (w.address) {
      const c = Object.values(characters).find((x) => x.address === w.address);
      parts.push(c ? `characterId=${c.id}` : `address=${w.address}`);
    }
    if (w.category) {
      const it = Object.values(items).find((x) => x.category === w.category);
      parts.push(it ? `itemId=${it.id}` : `category=${w.category}`);
    }
    if (!w.address && siblingWhens.some((x) => x?.address)) {
      const used = new Set(siblingWhens.map((x) => x?.address).filter(Boolean));
      const c = Object.values(characters).find((x) => !used.has(x.address));
      if (c) parts.push(`characterId=${c.id}\uFF08address=${c.address}\uFF0C\u907F\u5F00\u4E13\u7528\u53E5\u5F0F\uFF09`);
    }
    if (!w.category && siblingWhens.some((x) => x?.category)) {
      const used = new Set(siblingWhens.map((x) => x?.category).filter(Boolean));
      const it = Object.values(items).find((x) => !used.has(x.category));
      if (it) parts.push(`itemId=${it.id}\uFF08category=${it.category}\uFF09`);
    }
    if (!w.count && siblingWhens.some((x) => x?.count)) {
      const used = new Set(siblingWhens.map((x) => x?.count).filter(Boolean));
      const bucket = ["zero", "one", "other"].find((b) => !used.has(b));
      const count = exampleCountForBucket(bucket);
      if (count !== void 0) parts.push(`count=${count}\uFF08\u8D70\u672A\u9650\u5B9A\u6570\u91CF\u7684\u901A\u7528\u53E5\uFF09`);
    }
    return parts.length ? parts.join("\uFF0C") : "\u4EFB\u610F\u4E0A\u4E0B\u6587\uFF08\u65E0\u6761\u4EF6\u901A\u7528\u53E5\uFF09";
  }
  function runChecks(deps) {
    const { packs, referenceLocale, samples, characters, items } = deps;
    const issues = [];
    const refPack = packs[referenceLocale];
    const reachedForms = /* @__PURE__ */ new Set();
    const referencedEntries = /* @__PURE__ */ new Set();
    for (const sample of samples) {
      referencedEntries.add(sample.entryId);
      const refEntry = refPack?.entries[sample.entryId];
      const params = refEntry?.params;
      if (refPack && params) {
        const refCtx2 = buildContext(sample, referenceLocale, refPack, characters, items);
        for (const [name, spec] of Object.entries(params)) {
          const has = Object.prototype.hasOwnProperty.call(refCtx2.values, name);
          const value = refCtx2.values[name];
          const empty = value === void 0 || value === null || value === "";
          if (spec.required !== false && (!has || empty)) {
            issues.push(
              baseIssue(
                {
                  kind: "var-missing",
                  code: "required-value-missing",
                  severity: "error",
                  locale: "*",
                  entryId: sample.entryId,
                  message: `\u4E8B\u4EF6\u6CA1\u6709\u63D0\u4F9B\u5FC5\u9700\u53D8\u91CF {${name}}`,
                  expected: spec.type,
                  actual: "undefined"
                },
                sample
              )
            );
            continue;
          }
          if (has && !empty && !typeMatches(spec.type, value)) {
            issues.push(
              baseIssue(
                {
                  kind: "type-mismatch",
                  code: "param-type-mismatch",
                  severity: "error",
                  locale: "*",
                  entryId: sample.entryId,
                  message: `\u53D8\u91CF {${name}} \u5E94\u4E3A ${spec.type}\uFF0C\u6837\u4F8B\u5B9E\u9645\u4F20\u5165 ${typeName(value)}`,
                  expected: spec.type,
                  actual: typeName(value)
                },
                sample
              )
            );
          }
        }
      }
      const refCtx = refPack ? buildContext(sample, referenceLocale, refPack, characters, items) : void 0;
      const refWithin = refPack ? resolveWithin(refPack, sample.entryId, refCtx.match) : null;
      const referencePlaceholders = refWithin ? extractPlaceholders(refWithin.form.text) : Object.keys(params ?? {});
      for (const [locale, pack] of Object.entries(packs)) {
        const ctx2 = buildContext(sample, locale, pack, characters, items);
        const within = resolveWithin(pack, sample.entryId, ctx2.match);
        const resolved = resolveWithFallback(packs, locale, sample.entryId, ctx2.match);
        if (resolved.source.via === "missing") {
          issues.push(
            baseIssue(
              {
                kind: "missing-entry",
                code: "entry-unresolved",
                severity: "error",
                locale,
                entryId: sample.entryId,
                message: "\u6574\u6761\u56DE\u9000\u94FE\u90FD\u627E\u4E0D\u5230\u53EF\u7528\u6587\u6848"
              },
              sample
            )
          );
        } else if (resolved.source.locale !== locale) {
          issues.push(
            baseIssue(
              {
                kind: "fallback-used",
                code: "locale-fallback",
                severity: "warning",
                locale,
                entryId: sample.entryId,
                when: resolved.source.when ?? void 0,
                message: `\u672C\u8BED\u8A00\u7F3A\u5C11\u53EF\u7528\u6761\u76EE/\u53E5\u5F0F\uFF0C\u8BD5\u73A9\u6587\u672C\u56DE\u9000\u81EA ${resolved.source.locale}`,
                expected: locale,
                actual: resolved.source.locale
              },
              sample
            )
          );
        }
        if (!within) continue;
        reachedForms.add(`${locale}:${sample.entryId}:${within.index}`);
        const targetPH = extractPlaceholders(within.form.text);
        const targetSet = new Set(targetPH);
        const when = within.form.when ?? {};
        for (const name of referencePlaceholders) {
          if (!targetSet.has(name)) {
            issues.push(
              baseIssue(
                {
                  kind: "var-missing",
                  code: "placeholder-dropped",
                  severity: "error",
                  locale,
                  entryId: sample.entryId,
                  when,
                  message: `\u8BD1\u6587\u53E5\u5F0F\u6F0F\u6389\u4E86\u57FA\u51C6\u53E5\u5F0F\u4E2D\u7684\u53D8\u91CF {${name}}`,
                  expected: `\u5E94\u5305\u542B {${name}}`,
                  actual: within.form.text
                },
                sample
              )
            );
          }
        }
        const allowed = /* @__PURE__ */ new Set([...Object.keys(params ?? {}), ...referencePlaceholders]);
        for (const name of targetPH) {
          if (!allowed.has(name)) {
            issues.push(
              baseIssue(
                {
                  kind: "var-extra",
                  code: "placeholder-undeclared",
                  severity: "error",
                  locale,
                  entryId: sample.entryId,
                  when,
                  message: `\u8BD1\u6587\u4F7F\u7528\u4E86\u5951\u7EA6\u548C\u57FA\u51C6\u53E5\u5F0F\u4E2D\u90FD\u4E0D\u5B58\u5728\u7684\u53D8\u91CF {${name}}\uFF0C\u7591\u4F3C\u62FC\u5199\u9519\u8BEF`,
                  expected: [...allowed].map((x) => `{${x}}`).join(", ") || "(\u65E0)",
                  actual: `{${name}}`
                },
                sample
              )
            );
          }
        }
        for (const key of Object.keys(sample.vars ?? {})) {
          if (!targetSet.has(key)) {
            issues.push(
              baseIssue(
                {
                  kind: "var-extra",
                  code: "value-unused",
                  severity: "warning",
                  locale,
                  entryId: sample.entryId,
                  when,
                  message: `\u6837\u4F8B\u4F20\u5165\u7684\u53D8\u91CF {${key}} \u5728\u547D\u4E2D\u53E5\u5F0F\u4E2D\u6CA1\u6709\u88AB\u4F7F\u7528`,
                  actual: key
                },
                sample
              )
            );
          }
        }
      }
    }
    for (const [locale, pack] of Object.entries(packs)) {
      for (const entry of Object.values(pack.entries)) {
        if (!referencedEntries.has(entry.id)) continue;
        entry.forms.forEach((form, index) => {
          if (reachedForms.has(`${locale}:${entry.id}:${index}`)) return;
          const when = form.when ?? {};
          issues.push({
            kind: "unreached-form",
            code: "form-never-selected",
            severity: "warning",
            locale,
            entryId: entry.id,
            when,
            message: "\u8BE5\u53E5\u5F0F\u6CA1\u6709\u88AB\u4EFB\u4F55\u4E8B\u4EF6/\u77E9\u9635\u6837\u4F8B\u89E6\u53D1\uFF0C\u53EF\u80FD\u662F\u6B7B\u6587\u6848\u6216\u6761\u4EF6\u5199\u9519",
            actual: form.text,
            suggestedTrigger: suggestTrigger(
              when,
              characters,
              items,
              entry.forms.map((f) => f.when ?? {})
            )
          });
        });
      }
    }
    return issues;
  }
  function typeName(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }
  function aggregateIssues(issues) {
    const groups = /* @__PURE__ */ new Map();
    for (const issue of issues) {
      const key = JSON.stringify([
        issue.kind,
        issue.code,
        issue.locale,
        issue.entryId,
        whenSignature(issue.when ?? null),
        issue.message,
        issue.expected ?? "",
        issue.actual ?? "",
        issue.suggestedTrigger ?? "",
        issue.severity
      ]);
      const existing = groups.get(key);
      if (existing) {
        existing.sampleCount = (existing.sampleCount ?? 1) + 1;
        if (issue.sampleId) existing.relatedSampleIds.push(issue.sampleId);
      } else {
        groups.set(key, {
          ...issue,
          sampleCount: 1,
          relatedSampleIds: issue.sampleId ? [issue.sampleId] : []
        });
      }
    }
    const severityRank = { error: 0, warning: 1, info: 2 };
    const kindRank = {
      "var-missing": 0,
      "type-mismatch": 1,
      "var-extra": 2,
      "missing-entry": 3,
      "fallback-used": 4,
      "unreached-form": 5
    };
    return [...groups.values()].sort((a, b) => {
      const s = severityRank[a.severity] - severityRank[b.severity];
      if (s) return s;
      const k = kindRank[a.kind] - kindRank[b.kind];
      if (k) return k;
      return `${a.locale}${a.entryId}`.localeCompare(`${b.locale}${b.entryId}`);
    });
  }

  // src/ui/state.ts
  function recomputeIssues(packs) {
    const rawIssues = runChecks({
      packs,
      characters: Object.fromEntries(CHARACTERS.map((c) => [c.id, c])),
      items: Object.fromEntries(ITEMS.map((i) => [i.id, i])),
      referenceLocale: REFERENCE_LOCALE,
      samples: ALL_SAMPLES
    });
    return { rawIssues, issues: aggregateIssues(rawIssues) };
  }
  function createInitialState() {
    const packs = clonePacks(BASELINE_PACKS);
    const { rawIssues, issues } = recomputeIssues(packs);
    return {
      tab: "play",
      locale: "zh-CN",
      characterId: "vera",
      itemId: "moon_tonic",
      count: 2,
      characters: CHARACTERS,
      items: ITEMS,
      baselinePacks: clonePacks(BASELINE_PACKS),
      packs,
      rawIssues,
      issues,
      issueFilter: "all",
      checklistOpen: false,
      diffLocale: "ja-JP",
      diff: null,
      diffFilter: "all",
      packJson: JSON.stringify(BASELINE_PACKS["ja-JP"], null, 2),
      jsonError: null
    };
  }

  // src/core/render.ts
  function renderSample(deps, sample, locale) {
    const pack = deps.packs[locale] ?? deps.packs["zh-CN"];
    const ctx2 = buildContext(sample, locale, pack, deps.characters, deps.items);
    const resolved = resolveWithFallback(deps.packs, locale, sample.entryId, ctx2.match);
    const sourceEntry = resolved.pack?.entries[sample.entryId];
    const refEntry = deps.packs["zh-CN"]?.entries[sample.entryId];
    const params = sourceEntry?.params ?? refEntry?.params;
    const { parts, text } = renderTemplate(resolved.text, ctx2.values, params);
    const placeholders = parts.filter((p) => p.type === "var").map((p) => p.varName);
    const issues = [];
    if (resolved.source.via === "missing") {
      issues.push({
        kind: "missing-entry",
        code: "entry-unresolved",
        severity: "error",
        locale,
        entryId: sample.entryId,
        sampleId: sample.id,
        sampleLabel: sample.label,
        eventId: sample.eventId,
        message: "\u56DE\u9000\u94FE\u4E0A\u627E\u4E0D\u5230\u4EFB\u4F55\u53EF\u7528\u6587\u6848",
        trigger: { ...sample.vars, characterId: sample.characterId, itemId: sample.itemId, count: sample.count }
      });
    } else if (resolved.source.locale !== locale) {
      issues.push({
        kind: "fallback-used",
        code: "locale-fallback",
        severity: "warning",
        locale: resolved.source.locale,
        entryId: sample.entryId,
        sampleId: sample.id,
        sampleLabel: sample.label,
        eventId: sample.eventId,
        when: resolved.source.when ?? void 0,
        message: `${locale} \u672A\u7FFB\u8BD1\u8BE5\u6761\u76EE\uFF0C\u8BD5\u73A9\u6587\u672C\u6765\u81EA ${resolved.source.locale}`
      });
    }
    for (const part of parts) {
      if (part.type !== "var" || !part.varName) continue;
      const spec = params?.[part.varName];
      const raw = ctx2.values[part.varName];
      if (part.state === "missing") {
        issues.push({
          kind: "var-missing",
          code: "value-missing-at-render",
          severity: "error",
          locale: resolved.source.locale,
          entryId: sample.entryId,
          sampleId: sample.id,
          sampleLabel: sample.label,
          eventId: sample.eventId,
          message: `\u6A21\u677F\u53D8\u91CF {${part.varName}} \u6CA1\u6709\u62FF\u5230\u503C`
        });
      } else if (part.state === "bad-type" && spec) {
        issues.push({
          kind: "type-mismatch",
          code: "value-type-mismatch-at-render",
          severity: "error",
          locale: "*",
          entryId: sample.entryId,
          sampleId: sample.id,
          sampleLabel: sample.label,
          eventId: sample.eventId,
          message: `\u53D8\u91CF {${part.varName}} \u5E94\u4E3A ${spec.type}\uFF0C\u5B9E\u9645\u4E3A ${typeLabel(raw)}`,
          expected: spec.type,
          actual: typeLabel(raw)
        });
      }
    }
    const ok = !issues.some((i) => i.severity === "error");
    return {
      sampleId: sample.id,
      eventId: sample.eventId,
      lineId: sample.lineId,
      entryId: sample.entryId,
      locale,
      ok,
      text,
      parts,
      source: resolved.source,
      issues,
      values: ctx2.values,
      placeholders
    };
  }
  function typeLabel(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  // src/core/diff.ts
  function snapshotSamples(deps, samples, locale) {
    return samples.map((sample) => {
      const r = renderSample(deps, sample, locale);
      return {
        sampleId: sample.id,
        sampleLabel: sample.label,
        eventId: sample.eventId,
        entryId: sample.entryId,
        locale,
        text: r.text,
        sourceSignature: r.source.signature,
        sourceLabel: r.source.label + (r.source.via !== "exact" ? `\uFF08${viaText(r.source.via)}\uFF09` : ""),
        ok: r.ok
      };
    });
  }
  function viaText(via) {
    switch (via) {
      case "exact":
        return "\u7CBE\u786E\u547D\u4E2D";
      case "generic-form":
        return "\u901A\u7528\u53E5\u5F0F\u56DE\u9000";
      case "count-fallback":
        return "\u6570\u91CF\u5F0F\u56DE\u9000";
      case "locale-fallback":
        return "\u8DE8\u8BED\u8A00\u56DE\u9000";
      case "missing":
        return "\u6587\u6848\u7F3A\u5931";
      default:
        return via;
    }
  }
  function diffSnapshots(before, after, locale, now = (/* @__PURE__ */ new Date()).toISOString()) {
    const beforeMap = new Map(before.map((r) => [r.sampleId, r]));
    const rows = [];
    for (const a of after) {
      const b = beforeMap.get(a.sampleId);
      if (!b) continue;
      let status;
      if (b.text !== a.text) status = "text-changed";
      else if (b.sourceSignature !== a.sourceSignature || b.sourceLabel !== a.sourceLabel)
        status = "source-only";
      else if (b.ok !== a.ok) status = "status-changed";
      else status = "unchanged";
      rows.push({
        key: a.sampleId,
        sampleId: a.sampleId,
        sampleLabel: a.sampleLabel,
        eventId: a.eventId,
        entryId: a.entryId,
        status,
        before: b,
        after: a
      });
    }
    return {
      locale,
      generatedAt: now,
      total: rows.length,
      textChanged: rows.filter((r) => r.status === "text-changed"),
      sourceOnly: rows.filter((r) => r.status === "source-only"),
      statusChanged: rows.filter((r) => r.status === "status-changed"),
      unchangedCount: rows.filter((r) => r.status === "unchanged").length,
      rows
    };
  }

  // src/ui/widgets.ts
  var LOCALE_SHORT = {
    "zh-CN": "\u4E2D\u6587",
    "en-US": "EN",
    "ja-JP": "\u65E5"
  };
  function localeShort(locale) {
    return LOCALE_SHORT[locale] ?? locale;
  }
  function sourceBadge(source) {
    const cls = `src-badge src-${source.via}`;
    let text;
    if (source.via === "exact") text = `\u2713 ${localeShort(source.locale)} \xB7 \u4E13\u7528\u53E5`;
    else if (source.via === "locale-fallback")
      text = `\u26A0 \u8DE8\u8BED\u8A00\u56DE\u9000 \u2192 ${localeShort(source.locale)}`;
    else if (source.via === "missing") text = "\u2715 \u6587\u6848\u7F3A\u5931";
    else text = `\u21B3 ${localeShort(source.locale)} \xB7 ${viaText(source.via)}`;
    return h(
      "span",
      {
        class: cls,
        title: [source.label, ...source.hops].join("\n")
      },
      text
    );
  }
  function partsNodes(parts) {
    return parts.map((p) => {
      if (p.type === "text") return p.value;
      const cls = p.state === "missing" ? "tok tok-missing" : p.state === "bad-type" ? "tok tok-badtype" : "tok";
      return h(
        "span",
        {
          class: cls,
          title: p.state === "missing" ? `\u7F3A\u5C11\u53D8\u91CF\u503C\uFF1A${p.varName}` : p.state === "bad-type" ? `\u53D8\u91CF\u7C7B\u578B\u4E0D\u5408\u5951\u7EA6\uFF1A${p.varName}` : `\u53D8\u91CF ${p.varName}`
        },
        p.shown ?? p.value
      );
    });
  }
  function resultFlags(result) {
    const flags = [];
    const missing = result.parts.filter((p) => p.state === "missing");
    const bad = result.parts.filter((p) => p.state === "bad-type");
    if (missing.length)
      flags.push(h("span", { class: "flag flag-error" }, `\u7F3A\u503C \xD7${missing.length}`));
    if (bad.length) flags.push(h("span", { class: "flag flag-error" }, `\u7C7B\u578B\u4E0D\u5408 \xD7${bad.length}`));
    if (result.source.via === "locale-fallback")
      flags.push(h("span", { class: "flag flag-fallback" }, "\u672A\u7FFB\u8BD1\xB7\u56DE\u9000"));
    if (!flags.length) return null;
    return h("span", { class: "flags" }, ...flags);
  }

  // src/ui/panels/play.ts
  function speakerName(id, locale) {
    return SPEAKERS[id]?.[locale] ?? SPEAKERS[id]?.["zh-CN"] ?? id;
  }
  function rehearsed(sample, ctx2) {
    const { characterId, itemId, count } = ctx2.state;
    return { ...sample, characterId, itemId, count };
  }
  function DialogueLineView(sample, speakerId, ctx2) {
    const s = ctx2.state;
    const r = renderSample(
      { packs: s.packs, characters: Object.fromEntries(s.characters.map((c) => [c.id, c])), items: Object.fromEntries(s.items.map((i) => [i.id, i])) },
      rehearsed(sample, ctx2),
      s.locale
    );
    return h(
      "div",
      { class: `dlg-line ${r.ok ? "" : "dlg-line-error"}` },
      h("div", { class: "dlg-speaker" }, speakerName(speakerId, s.locale)),
      h("div", { class: "dlg-body" }, ...partsNodes(r.parts)),
      h(
        "div",
        { class: "dlg-meta" },
        sourceBadge(r.source),
        resultFlags(r),
        h("span", { class: "sample-id", title: sample.label }, sample.id)
      ),
      r.source.hops.length ? h("div", { class: "dlg-hops" }, "\u8F68\u8FF9\uFF1A" + r.source.hops.join(" \u2192 ")) : null
    );
  }
  function EventCard(eventId, ctx2) {
    const ev = EVENTS.find((e) => e.id === eventId);
    return h(
      "section",
      { class: "card event-card" },
      h("header", { class: "card-head" }, h("h3", null, ev.title), h("p", { class: "card-blurb" }, ev.blurb)),
      h(
        "div",
        { class: "dlg-list" },
        ...ev.lines.map((line) => DialogueLineView(line.sample, line.speakerId, ctx2))
      )
    );
  }
  function sourceDot(signature, via, label) {
    return h("span", { class: `src-dot src-${via}`, title: label }, localeShort(signature.split("::")[0] ?? ""));
  }
  function MatrixTable(id, title, description, samples, ctx2) {
    const s = ctx2.state;
    const byKey = new Map(samples.map((x) => [`${x.itemId}:${x.count}`, x]));
    const head = h(
      "tr",
      null,
      h("th", null, "\u7269\u54C1 \\ \u6570\u91CF"),
      ...MATRIX_COUNTS.map((n) => h("th", { class: "num" }, n === 0 ? "0\uFF08\u96F6\uFF09" : n === 1 ? "1\uFF08\u5355\u6570\uFF09" : `${n}\uFF08\u590D\u6570\uFF09`))
    );
    const rows = ITEMS.map(
      (item) => h(
        "tr",
        null,
        h("th", { scope: "row" }, item.name[s.locale] ?? item.name["zh-CN"], h("span", { class: "cat-tag" }, categoryLabel(item.category, s.locale))),
        ...MATRIX_COUNTS.map((n) => {
          const base = byKey.get(`${item.id}:${n}`);
          const sample = { ...base, characterId: s.characterId };
          const r = renderSample(
            {
              packs: s.packs,
              characters: Object.fromEntries(s.characters.map((c) => [c.id, c])),
              items: Object.fromEntries(s.items.map((i) => [i.id, i]))
            },
            sample,
            s.locale
          );
          return h(
            "td",
            { class: `matrix-cell ${r.ok ? "" : "matrix-cell-error"}` },
            h("div", { class: "matrix-text" }, ...partsNodes(r.parts)),
            h("div", { class: "matrix-src" }, sourceDot(r.source.signature, r.source.via, r.source.label + "\n" + r.source.hops.join("\n")))
          );
        })
      )
    );
    return h(
      "section",
      { class: "card matrix-card", id },
      h("header", { class: "card-head" }, h("h3", null, title), h("p", { class: "card-blurb" }, description)),
      h("div", { class: "table-wrap" }, h("table", { class: "matrix-table" }, h("thead", null, head), h("tbody", null, ...rows)))
    );
  }
  function renderPlayTab(ctx2) {
    return h(
      "div",
      { class: "tab-play" },
      h(
        "div",
        { class: "notice" },
        "\u9876\u90E8\u63A7\u5236\u53F0\u6B63\u5728\u6279\u91CF\u8986\u76D6\u6BCF\u6761\u5BF9\u767D\u7684\u89D2\u8272 / \u7269\u54C1 / \u6570\u91CF\uFF1B\u96F6\u3001\u5355\u6570\u3001\u590D\u6570\u53EF\u76F4\u63A5\u7528\u6570\u91CF\u6309\u94AE\u5207\u6362\u3002\u5355\u53E5\u51FA\u9519\u4F1A\u6807\u7EA2\uFF0C\u4F46\u5176\u4ED6\u53F0\u8BCD\u7EE7\u7EED\u6E32\u67D3\u3002\u539F\u59CB\u6837\u4F8B\u4E0A\u4E0B\u6587\u89C1\u300C\u8D28\u68C0\u6E05\u5355\u300D\u3002"
      ),
      ...EVENTS.map((e) => EventCard(e.id, ctx2)),
      MatrixTable(
        "matrix-buy",
        "\u6279\u91CF\u9884\u6F14 \xB7 \u8D2D\u4E70\u53E5\u77E9\u9635",
        "\u884C\u662F\u7269\u54C1\u7C7B\u522B\uFF08\u5F71\u54CD\u4E2D\u6587\u91CF\u8BCD\u7B49\uFF09\uFF0C\u5217\u662F\u6570\u91CF\u53E5\u5F0F\uFF1B\u53F3\u4E0B\u89D2\u5C0F\u6807\u662F\u8BE5\u683C\u771F\u5B9E\u8D44\u6E90\u6765\u6E90\u3002",
        BUY_MATRIX_SAMPLES,
        ctx2
      ),
      MatrixTable(
        "matrix-inspect",
        "\u6279\u91CF\u9884\u6F14 \xB7 \u9053\u5177\u8BF4\u660E\u77E9\u9635",
        "\u540C\u4E00\u53E5 item.inspect \u540C\u65F6\u5305\u542B\u79F0\u547C\u3001\u7269\u54C1\u540D\u548C\u6570\u91CF\u53D8\u91CF\u3002",
        INSPECT_MATRIX_SAMPLES,
        ctx2
      )
    );
  }

  // src/core/checklist.ts
  var KIND_LABEL = {
    "var-missing": "\u53D8\u91CF\u7F3A\u5931",
    "var-extra": "\u53D8\u91CF\u591A\u51FA",
    "type-mismatch": "\u7C7B\u578B\u4E0D\u5408",
    "unreached-form": "\u672A\u8D70\u5230\u7684\u53E5\u5F0F",
    "fallback-used": "\u56DE\u9000\u4F7F\u7528",
    "missing-entry": "\u6761\u76EE\u7F3A\u5931"
  };
  var CODE_LABEL = {
    "placeholder-dropped": "\u8BD1\u6587\u6F0F\u7528\u4E86\u57FA\u51C6\u53D8\u91CF",
    "required-value-missing": "\u4E8B\u4EF6\u6F0F\u4F20\u5FC5\u9700\u53D8\u91CF",
    "value-missing-at-render": "\u6E32\u67D3\u65F6\u53D8\u91CF\u65E0\u503C",
    "placeholder-undeclared": "\u6A21\u677F\u51FA\u73B0\u5951\u7EA6\u5916\u53D8\u91CF\uFF08\u7591\u4F3C\u62FC\u5199\u9519\u8BEF\uFF09",
    "value-unused": "\u6837\u4F8B\u4F20\u5165\u7684\u53D8\u91CF\u672A\u88AB\u53E5\u5F0F\u4F7F\u7528",
    "param-type-mismatch": "\u6837\u4F8B\u503C\u7C7B\u578B\u4E0E\u53D8\u91CF\u5951\u7EA6\u4E0D\u7B26",
    "value-type-mismatch-at-render": "\u6E32\u67D3\u65F6\u503C\u7C7B\u578B\u4E0D\u7B26",
    "form-never-selected": "\u53E5\u5F0F\u4ECE\u672A\u88AB\u89E6\u53D1",
    "locale-fallback": "\u8DE8\u8BED\u8A00\u56DE\u9000",
    "entry-unresolved": "\u56DE\u9000\u94FE\u4E0A\u65E0\u6587\u6848"
  };
  function codeLabel(code) {
    return CODE_LABEL[code] ?? code;
  }
  function formatIssue(issue) {
    const lines = [];
    const where = issue.locale === "*" ? "\u5168\u90E8\u8BED\u8A00\uFF08\u6837\u4F8B\u6570\u636E\uFF09" : `\u8BED\u8A00 \`${issue.locale}\``;
    lines.push(`- [ ] **[${KIND_LABEL[issue.kind]}] ${codeLabel(issue.code)}**`);
    lines.push(`  - \u4F4D\u7F6E\uFF1A${where}\uFF0C\u6761\u76EE \`${issue.entryId}\``);
    if (issue.when && Object.keys(issue.when).length) {
      lines.push(`  - \u53E5\u5F0F\uFF1A\`${whenSignature(issue.when)}\`\uFF08${whenLabel(issue.when)}\uFF09`);
    }
    lines.push(`  - \u95EE\u9898\uFF1A${issue.message}`);
    if (issue.expected) lines.push(`  - \u671F\u671B\uFF1A${issue.expected}`);
    if (issue.actual && issue.code !== "placeholder-dropped") {
      const actual = issue.actual.length > 160 ? issue.actual.slice(0, 160) + "\u2026" : issue.actual;
      lines.push(`  - \u5B9E\u9645/\u539F\u6587\uFF1A${actual}`);
    }
    if (issue.suggestedTrigger) {
      lines.push(`  - \u5EFA\u8BAE\u8865\u7684\u89E6\u53D1\u6837\u4F8B\uFF1A\`${issue.suggestedTrigger}\``);
    }
    if (issue.sampleCount && issue.sampleCount > 1) {
      const ids = issue.relatedSampleIds ?? [];
      const shown = ids.slice(0, 8).map((id) => `\`${id}\``).join("\u3001");
      lines.push(
        `  - \u89E6\u53D1\u6837\u4F8B\uFF1A\u5171 **${issue.sampleCount}** \u4E2A\uFF0C\u9996\u4E2A \`${issue.sampleId}\`\uFF08${issue.sampleLabel ?? ""}\uFF09`
      );
      if (shown) lines.push(`    - \u6837\u4F8B ID\uFF1A${shown}${ids.length > 8 ? ` \u7B49 ${ids.length} \u4E2A` : ""}`);
    } else if (issue.sampleId) {
      lines.push(`  - \u89E6\u53D1\u6837\u4F8B\uFF1A\`${issue.sampleId}\`\uFF08${issue.sampleLabel ?? ""}\uFF09`);
    }
    if (issue.trigger && Object.keys(issue.trigger).length) {
      lines.push("  - \u590D\u73B0\u4E0A\u4E0B\u6587\uFF1A");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(issue.trigger, null, 2));
      lines.push("```");
    }
    return lines.join("\n");
  }
  function buildChecklistMarkdown(args) {
    const { issues, localeOrder, samples, rawIssueCount } = args;
    const generatedAt = args.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
    const title = args.title ?? "\u300A\u661F\u6E2F\u6742\u8D27\u94FA\u300B\u6587\u6848\u4E0A\u4E0B\u6587\u8D28\u68C0\u6E05\u5355";
    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");
    const kindCounts = /* @__PURE__ */ new Map();
    for (const i of issues) kindCounts.set(i.kind, (kindCounts.get(i.kind) ?? 0) + 1);
    const out = [];
    out.push(`# ${title}`);
    out.push("");
    out.push(`- \u751F\u6210\u65F6\u95F4\uFF1A${generatedAt}`);
    out.push("- \u8FD0\u884C\u65B9\u5F0F\uFF1A\u672C\u5730\u79BB\u7EBF\u8FD0\u884C\uFF08`npm run qa`\uFF09\uFF0C\u4E0D\u4F9D\u8D56\u4EFB\u4F55\u7F51\u7EDC\u670D\u52A1");
    out.push(`- \u626B\u63CF\u8BED\u8A00\uFF1A${localeOrder.map((l) => `\`${l}\``).join(" / ")}`);
    out.push(`- \u89E6\u53D1\u6837\u4F8B\uFF1A${samples.length} \u4E2A\uFF08\u5BF9\u8BDD\u4E8B\u4EF6 + \u6570\u91CF/\u7269\u54C1\u77E9\u9635\uFF09`);
    out.push(`- \u805A\u5408\u540E\u95EE\u9898\uFF1A**${issues.length}** \u7EC4\uFF1B\u6309\u6837\u4F8B\u8BA1\u7684\u539F\u59CB\u89E6\u53D1\uFF1A${rawIssueCount} \u6B21`);
    out.push(`- \u9519\u8BEF ${errors.length} \u7EC4\uFF0C\u8B66\u544A ${warnings.length} \u7EC4`);
    out.push("");
    out.push("## \u603B\u89C8\uFF08\u6309\u7C7B\u522B\u5206\u5F00\u7EDF\u8BA1\uFF09");
    out.push("");
    out.push("| \u7C7B\u522B | \u95EE\u9898\u7EC4\u6570 |");
    out.push("| --- | ---: |");
    Object.keys(KIND_LABEL).forEach((kind) => {
      out.push(`| ${KIND_LABEL[kind]} | ${kindCounts.get(kind) ?? 0} |`);
    });
    out.push("");
    out.push("> \u6765\u6E90\u6807\u8BB0\u7EA6\u5B9A\uFF1A`exact` \u7CBE\u786E\u4E13\u7528\u53E5\u5F0F\uFF1B`generic-form` / `count-fallback` \u4E3A\u672C\u8BED\u8A00\u7EA6\u5B9A\u56DE\u9000\uFF1B");
    out.push("> `locale-fallback` \u4E3A\u8DE8\u8BED\u8A00\u56DE\u9000\uFF08**\u4E0D\u7B97\u5DF2\u7FFB\u8BD1**\uFF09\uFF1B`missing` \u4E3A\u8D44\u6E90\u7F3A\u5931\u3002");
    out.push("");
    out.push("## \u4E00\u3001\u5FC5\u987B\u4FEE\u590D\u7684\u9519\u8BEF");
    out.push("");
    if (!errors.length) out.push("- \u65E0 \u{1F389}");
    else out.push(errors.map(formatIssue).join("\n\n"));
    out.push("");
    out.push("## \u4E8C\u3001\u8B66\u544A\u4E0E\u56DE\u9000");
    out.push("");
    if (!warnings.length) out.push("- \u65E0");
    else out.push(warnings.map(formatIssue).join("\n\n"));
    out.push("");
    const eventSamples = samples.filter((s) => s.eventId !== "ev_matrix");
    out.push("## \u4E09\u3001\u5BF9\u8BDD\u4E8B\u4EF6\u4E09\u8BED\u8BD5\u73A9\u7ED3\u679C\uFF08\u542B\u771F\u5B9E\u6765\u6E90\uFF09");
    out.push("");
    for (const sample of eventSamples) {
      out.push(`### ${sample.eventId} / \`${sample.id}\` ${sample.label}`);
      out.push("");
      for (const locale of localeOrder) {
        const r = renderSample(args, sample, locale);
        const badge = r.source.via === "exact" ? `\u2705 \u7CBE\u786E \xB7 ${r.source.label}` : r.source.via === "locale-fallback" ? `\u26A0\uFE0F \u8DE8\u8BED\u8A00\u56DE\u9000\uFF08\u4E0D\u7B97\u5DF2\u7FFB\u8BD1\uFF09\xB7 ${r.source.label}` : r.source.via === "missing" ? `\u274C \u7F3A\u5931 \xB7 ${r.source.label}` : `\u21B3 \u672C\u8BED\u8A00\u7EA6\u5B9A\u56DE\u9000 \xB7 ${r.source.label}`;
        out.push(`- **${locale}**\uFF1A${r.text}`);
        out.push(`  - \u6765\u6E90\uFF1A${badge}`);
        if (r.source.hops.length) out.push(`  - \u56DE\u9000\u8F68\u8FF9\uFF1A${r.source.hops.join(" \u2192 ")}`);
      }
      out.push("");
    }
    out.push("---");
    out.push("");
    out.push("## \u56DB\u3001\u4F7F\u7528\u8BF4\u660E");
    out.push("");
    out.push("1. \u9875\u9762\u9876\u90E8\u53EF\u5207\u6362\u89D2\u8272\u3001\u7269\u54C1\u4E0E\u6570\u91CF\uFF080 / 1 / 2 / 5\uFF09\uFF0C\u6240\u6709\u5BF9\u8BDD\u4E0E\u77E9\u9635\u6279\u91CF\u91CD\u6E32\u67D3\u3002");
    out.push("2. \u4E00\u53E5\u53F0\u8BCD\u62A5\u9519\u4E0D\u4F1A\u5F71\u54CD\u540C\u4E8B\u4EF6\u5176\u4ED6\u53F0\u8BCD\u3002");
    out.push("3. \u5728\u300C\u66F4\u65B0\u5BF9\u6BD4\u300D\u9875\u7F16\u8F91\u6216\u4E00\u952E\u586B\u5165 ja-JP \u4FEE\u8BA2\u5305\uFF0C\u53EF\u67E5\u770B\u6587\u5B57\u53D8\u5316\u4E0E\u201C\u4EC5\u6765\u6E90\u53D8\u4E86\u201D\u3002");
    out.push("4. \u672C\u6E05\u5355\u7531\u9ED8\u8BA4\u865A\u6784\u6837\u4F8B\u751F\u6210\uFF0C\u63A5\u5165\u771F\u5B9E\u8BED\u8A00\u5305\u65F6\u66FF\u6362 `src/data/packs` \u4E0E `src/data/events.ts` \u5373\u53EF\u3002");
    out.push("");
    return out.join("\n");
  }

  // src/ui/panels/qa.ts
  var FILTERS = [
    { id: "all", label: "\u5168\u90E8" },
    { id: "var-missing", label: KIND_LABEL["var-missing"] },
    { id: "var-extra", label: KIND_LABEL["var-extra"] },
    { id: "type-mismatch", label: KIND_LABEL["type-mismatch"] },
    { id: "unreached-form", label: KIND_LABEL["unreached-form"] },
    { id: "fallback-used", label: KIND_LABEL["fallback-used"] },
    { id: "missing-entry", label: KIND_LABEL["missing-entry"] }
  ];
  function buildMarkdown(ctx2) {
    const s = ctx2.state;
    return buildChecklistMarkdown({
      packs: s.packs,
      characters: Object.fromEntries(s.characters.map((c) => [c.id, c])),
      items: Object.fromEntries(s.items.map((i) => [i.id, i])),
      localeOrder: Object.keys(s.packs),
      samples: ALL_SAMPLES,
      issues: s.issues,
      rawIssueCount: s.rawIssues.length
    });
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }
  function IssueCard(issue) {
    const samples = issue.relatedSampleIds ?? [];
    return h(
      "article",
      { class: `issue issue-${issue.severity} kind-${issue.kind}` },
      h(
        "header",
        { class: "issue-head" },
        h("span", { class: `kind-tag tag-${issue.kind}` }, KIND_LABEL[issue.kind]),
        h("span", { class: "issue-code" }, CODE_LABEL[issue.code] ?? issue.code),
        h("span", { class: `locale-pill locale-${issue.locale}` }, issue.locale === "*" ? "\u5168\u90E8\u8BED\u8A00" : issue.locale),
        h("code", { class: "entry-id" }, issue.entryId),
        issue.sampleCount && issue.sampleCount > 1 ? h("span", { class: "count-pill" }, `${issue.sampleCount} \u4E2A\u6837\u4F8B`) : null
      ),
      h("p", { class: "issue-msg" }, issue.message),
      issue.when && Object.keys(issue.when).length ? h(
        "p",
        { class: "issue-when" },
        "\u547D\u4E2D\u53E5\u5F0F\uFF1A",
        h("code", null, whenSignature(issue.when)),
        `\uFF08${whenLabel(issue.when)}\uFF09`
      ) : null,
      issue.expected ? h("p", { class: "issue-expected" }, "\u671F\u671B\uFF1A", h("code", null, issue.expected)) : null,
      issue.actual ? h(
        "p",
        { class: "issue-actual" },
        issue.code === "placeholder-dropped" ? "\u6240\u5728\u53E5\u5F0F\u539F\u6587\uFF1A" : "\u5B9E\u9645\uFF1A",
        h("q", null, issue.actual.length > 220 ? issue.actual.slice(0, 220) + "\u2026" : issue.actual)
      ) : null,
      issue.suggestedTrigger ? h("p", { class: "issue-suggest" }, "\u5EFA\u8BAE\u89E6\u53D1\u6837\u4F8B\uFF1A", h("code", null, issue.suggestedTrigger)) : null,
      issue.sampleId ? h(
        "p",
        { class: "issue-sample" },
        "\u89E6\u53D1\uFF1A",
        h("code", null, issue.sampleId),
        issue.sampleLabel ? ` \xB7 ${issue.sampleLabel}` : ""
      ) : null,
      samples.length > 1 ? h(
        "details",
        { class: "sample-list" },
        h("summary", null, `\u67E5\u770B ${samples.length} \u4E2A\u76F8\u5173\u6837\u4F8B ID`),
        h("div", { class: "sample-ids" }, samples.map((id) => h("code", { class: "sample-chip" }, id)))
      ) : null,
      issue.trigger && Object.keys(issue.trigger).length ? h(
        "details",
        { class: "trigger-json" },
        h("summary", null, "\u590D\u73B0\u4E0A\u4E0B\u6587 JSON"),
        h("pre", null, JSON.stringify(issue.trigger, null, 2))
      ) : null
    );
  }
  function renderQaTab(ctx2) {
    const s = ctx2.state;
    const filtered = s.issueFilter === "all" ? s.issues : s.issues.filter((i) => i.kind === s.issueFilter);
    const countFor = (id) => id === "all" ? s.issues.length : s.issues.filter((i) => i.kind === id).length;
    const markdown = s.checklistOpen ? buildMarkdown(ctx2) : "";
    return h(
      "div",
      { class: "tab-qa" },
      h(
        "section",
        { class: "card qa-toolbar" },
        h(
          "div",
          { class: "qa-summary" },
          h("div", { class: "stat stat-error" }, h("strong", null, String(s.rawIssues.filter((i) => i.severity === "error").length)), h("span", null, "\u9519\u8BEF\u89E6\u53D1\u6B21\u6570")),
          h("div", { class: "stat stat-warn" }, h("strong", null, String(s.rawIssues.filter((i) => i.severity === "warning").length)), h("span", null, "\u8B66\u544A\u89E6\u53D1\u6B21\u6570")),
          h("div", { class: "stat" }, h("strong", null, String(s.issues.length)), h("span", null, "\u805A\u5408\u95EE\u9898\u7EC4")),
          h("div", { class: "stat" }, h("strong", null, String(ALL_SAMPLES.length)), h("span", null, "\u89E6\u53D1\u6837\u4F8B"))
        ),
        h(
          "div",
          { class: "qa-actions" },
          h(
            "button",
            {
              class: "btn btn-primary",
              onclick: () => {
                const md = buildMarkdown(ctx2);
                downloadText(`qa-checklist-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.md`, md);
              }
            },
            "\u2B07 \u5BFC\u51FA Markdown \u8D28\u68C0\u6E05\u5355"
          ),
          h(
            "button",
            {
              class: "btn",
              onclick: async (e) => {
                const btn = e.currentTarget;
                const ok = await copyText(buildMarkdown(ctx2));
                const old = btn.textContent;
                btn.textContent = ok ? "\u2713 \u5DF2\u590D\u5236" : "\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u7528\u9884\u89C8\u5168\u9009";
                setTimeout(() => btn.textContent = old, 1600);
              }
            },
            "\u590D\u5236\u5168\u6587"
          ),
          h(
            "button",
            {
              class: "btn",
              onclick: () => ctx2.update({ checklistOpen: !s.checklistOpen })
            },
            s.checklistOpen ? "\u6536\u8D77\u6E05\u5355\u9884\u89C8" : "\u9884\u89C8\u6E05\u5355\u539F\u6587"
          )
        )
      ),
      s.checklistOpen ? h("pre", { class: "checklist-preview" }, markdown) : null,
      h(
        "div",
        { class: "filter-bar" },
        ...FILTERS.map(
          (f) => h(
            "button",
            {
              class: `chip ${s.issueFilter === f.id ? "chip-active" : ""}`,
              onclick: () => ctx2.update({ issueFilter: f.id })
            },
            f.label,
            h("span", { class: "chip-count" }, String(countFor(f.id)))
          )
        )
      ),
      h("div", { class: "issue-list" }, ...filtered.map(IssueCard)),
      filtered.length === 0 ? h("div", { class: "empty" }, "\u8BE5\u7C7B\u522B\u4E0B\u6CA1\u6709\u95EE\u9898 \u{1F389}") : null
    );
  }

  // src/data/packs/revision.ts
  function buildRevisedPacks() {
    const packs = clonePacks(BASELINE_PACKS);
    const ja = packs["ja-JP"];
    const inspect = ja.entries["item.inspect"];
    inspect.forms = inspect.forms.map(
      (f) => f.when.count === "other" ? { ...f, text: "{address}\u3001\u300C{item}\u300D\u306F\u307E\u3060 {count} \u500B\u3082\u6B8B\u3063\u3066\u3044\u308B\u3088\u3002" } : f
    );
    ja.entries["quest.remind"] = {
      id: "quest.remind",
      description: "\u30AF\u30A8\u30B9\u30C8\u30EA\u30DE\u30A4\u30F3\u30C9\uFF08v2 \u65B0\u898F\u7FFB\u8A33\uFF09",
      forms: [
        {
          when: { address: "captain" },
          text: "{address}\u3001\u5FD8\u308C\u308B\u306A\uFF1A{reward}\u3092\u6301\u3063\u3066{place}\u3067\u843D\u3061\u5408\u304A\u3046\u3002\u6E2F\u52D9\u9577\u306F\u5F85\u3063\u3066\u304F\u308C\u306A\u3044\u3002"
        },
        { when: {}, text: "{reward}\u3092\u6301\u3063\u3066{place}\u3067\u8001\u8235\u624B\u3092\u63A2\u3057\u3066\u306D\u3002" }
      ]
    };
    const buy = ja.entries["shop.buy"];
    buy.forms.push({
      when: { count: "other", category: "food" },
      // 故意与 when:{count:'other'} 通用句完全同文
      text: "\u300C{item}\u300D\u3092 {count} \u500B\u8CB7\u3063\u305F\u3002\u82D4\u304A\u3070\u306F\u76EE\u3092\u7D30\u3081\u3066\u7B11\u3046\u3002",
      note: "\u98DF\u3079\u7269\u30AB\u30C6\u30B4\u30EA\u5C02\u7528\u67A0\u3002\u73FE\u72B6\u306F\u901A\u7528\u53E5\u3068\u540C\u3058\u8A33\u6587\u3002"
    });
    return packs;
  }
  function revisedJaJson() {
    return JSON.stringify(buildRevisedPacks()["ja-JP"], null, 2);
  }

  // src/ui/panels/diff.ts
  function DiffRowView(row) {
    const statusLabel = {
      "text-changed": "\u6587\u5B57\u53D8\u4E86",
      "source-only": "\u4EC5\u6765\u6E90\u53D8\u4E86",
      "status-changed": "\u6210\u8D25\u72B6\u6001\u53D8\u4E86",
      unchanged: "\u672A\u53D8\u5316"
    };
    return h(
      "article",
      { class: `diff-row diff-${row.status}` },
      h(
        "header",
        { class: "diff-head" },
        h("span", { class: `diff-status status-${row.status}` }, statusLabel[row.status]),
        h("code", { class: "entry-id" }, row.entryId),
        h("span", { class: "sample-id" }, row.sampleId),
        h("span", { class: "sample-label" }, row.sampleLabel)
      ),
      h(
        "div",
        { class: "diff-grid" },
        h(
          "div",
          { class: "diff-col diff-before" },
          h("h5", null, "\u66F4\u65B0\u524D"),
          h("p", { class: "diff-text" }, row.before.text),
          h("p", { class: "diff-source" }, "\u6765\u6E90\uFF1A", row.before.sourceLabel)
        ),
        h(
          "div",
          { class: "diff-arrow" },
          "\u2192"
        ),
        h(
          "div",
          { class: "diff-col diff-after" },
          h("h5", null, "\u66F4\u65B0\u540E"),
          h("p", { class: "diff-text" }, row.after.text),
          h("p", { class: "diff-source" }, "\u6765\u6E90\uFF1A", row.after.sourceLabel)
        )
      )
    );
  }
  function renderDiffTab(ctx2) {
    const s = ctx2.state;
    const applyJson = () => {
      const ta = document.getElementById("pack-json-editor");
      if (!ta) return;
      let parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        ctx2.update({ jsonError: `JSON \u89E3\u6790\u5931\u8D25\uFF1A${e.message}` });
        return;
      }
      const candidate = parsed;
      if (!candidate || typeof candidate !== "object" || !candidate.entries || typeof candidate.entries !== "object") {
        ctx2.update({ jsonError: "\u8BED\u8A00\u5305\u5FC5\u987B\u5305\u542B entries \u5BF9\u8C61" });
        return;
      }
      candidate.locale = s.diffLocale;
      if (!candidate.terms?.address) {
        ctx2.update({ jsonError: "\u8BED\u8A00\u5305\u7F3A\u5C11 terms.address \u79F0\u547C\u8868" });
        return;
      }
      const characters = Object.fromEntries(s.characters.map((c) => [c.id, c]));
      const items = Object.fromEntries(s.items.map((i) => [i.id, i]));
      const nextPacks = {
        ...s.packs,
        [s.diffLocale]: candidate
      };
      const before = snapshotSamples(
        { packs: s.baselinePacks, characters, items },
        ALL_SAMPLES,
        s.diffLocale
      );
      const after = snapshotSamples({ packs: nextPacks, characters, items }, ALL_SAMPLES, s.diffLocale);
      const report2 = diffSnapshots(before, after, s.diffLocale);
      const { rawIssues, issues } = recomputeIssues(nextPacks);
      ctx2.update({
        packs: nextPacks,
        diff: report2,
        rawIssues,
        issues,
        jsonError: null,
        packJson: ta.value
      });
    };
    const loadBaselineJson = (locale) => {
      ctx2.update({
        diffLocale: locale,
        packJson: JSON.stringify(s.baselinePacks[locale], null, 2),
        jsonError: null,
        diff: null
      });
    };
    const fillRevision = () => {
      ctx2.update({ diffLocale: "ja-JP", packJson: revisedJaJson(), jsonError: null });
    };
    const resetPack = () => {
      const packs = JSON.parse(JSON.stringify(s.baselinePacks));
      const { rawIssues, issues } = recomputeIssues(packs);
      ctx2.update({
        packs,
        rawIssues,
        issues,
        diff: null,
        jsonError: null,
        packJson: JSON.stringify(s.baselinePacks[s.diffLocale], null, 2)
      });
    };
    const report = s.diff;
    const filter = s.diffFilter;
    const visibleRows = report ? report.rows.filter((r) => filter === "all" ? true : r.status === filter) : [];
    const filterChips = report ? [
      { id: "all", label: "\u5168\u90E8", count: report.total },
      { id: "text-changed", label: "\u6587\u5B57\u53D8\u4E86", count: report.textChanged.length },
      { id: "source-only", label: "\u4EC5\u6765\u6E90\u53D8\u4E86", count: report.sourceOnly.length },
      { id: "status-changed", label: "\u6210\u8D25\u53D8\u5316", count: report.statusChanged.length },
      { id: "unchanged", label: "\u672A\u53D8\u5316", count: report.unchangedCount }
    ] : [];
    return h(
      "div",
      { class: "tab-diff" },
      h(
        "section",
        { class: "card editor-card" },
        h(
          "header",
          { class: "card-head" },
          h("h3", null, "\u66F4\u65B0\u4E00\u4EFD\u8BED\u8A00\u5305"),
          h("p", { class: "card-blurb" }, "\u76F4\u63A5\u7F16\u8F91 JSON\uFF0C\u6216\u4E00\u952E\u586B\u5165\u9884\u7F6E\u7684 ja-JP \u4FEE\u8BA2\u5305\uFF0C\u7136\u540E\u5BF9\u6BD4\u540C\u4E00\u7EC4\u4E8B\u4EF6/\u77E9\u9635\u6837\u4F8B\u7684\u6E32\u67D3\u7ED3\u679C\u3002\u6240\u6709\u8BA1\u7B97\u90FD\u5728\u672C\u5730\u6D4F\u89C8\u5668\u5B8C\u6210\u3002")
        ),
        h(
          "div",
          { class: "editor-controls" },
          h(
            "label",
            null,
            "\u8BED\u8A00\uFF1A",
            h(
              "select",
              {
                onchange: (e) => loadBaselineJson(e.target.value)
              },
              ...LOCALE_ORDER.map((l) => h("option", { value: l, selected: l === s.diffLocale }, l))
            )
          ),
          h("button", { class: "btn", onclick: fillRevision }, "\u586B\u5165 ja-JP \u793A\u4F8B\u4FEE\u8BA2 v2"),
          h("button", { class: "btn btn-primary", onclick: applyJson }, "\u5E94\u7528\u66F4\u65B0\u5E76\u5BF9\u6BD4"),
          h("button", { class: "btn btn-ghost", onclick: resetPack }, "\u91CD\u7F6E\u5168\u90E8\u8BED\u8A00\u5305"),
          h("span", { class: "editor-hint" }, "\u5E94\u7528\u540E\u300C\u8D28\u68C0\u6E05\u5355\u300D\u4E5F\u4F1A\u6309\u65B0\u8BED\u8A00\u5305\u91CD\u65B0\u7EDF\u8BA1")
        ),
        s.jsonError ? h("div", { class: "json-error" }, s.jsonError) : null,
        h("textarea", {
          id: "pack-json-editor",
          class: "json-editor",
          spellcheck: false,
          value: s.packJson,
          rows: 18
        })
      ),
      report ? h(
        "section",
        { class: "diff-report" },
        h(
          "div",
          { class: "diff-summary card" },
          h("div", { class: "stat stat-text" }, h("strong", null, String(report.textChanged.length)), h("span", null, "\u6587\u5B57\u53D8\u5316")),
          h("div", { class: "stat stat-source" }, h("strong", null, String(report.sourceOnly.length)), h("span", null, "\u4EC5\u6765\u6E90\u53D8\u5316")),
          h("div", { class: "stat" }, h("strong", null, String(report.statusChanged.length)), h("span", null, "\u6210\u8D25\u72B6\u6001\u53D8\u5316")),
          h("div", { class: "stat" }, h("strong", null, String(report.unchangedCount)), h("span", null, "\u672A\u53D8\u5316"))
        ),
        h(
          "div",
          { class: "filter-bar" },
          ...filterChips.map(
            (c) => h(
              "button",
              {
                class: `chip ${filter === c.id ? "chip-active" : ""}`,
                onclick: () => ctx2.update({ diffFilter: c.id })
              },
              c.label,
              h("span", { class: "chip-count" }, String(c.count ?? 0))
            )
          )
        ),
        h("div", { class: "diff-list" }, ...visibleRows.map(DiffRowView))
      ) : h(
        "div",
        { class: "card empty diff-empty" },
        "\u7F16\u8F91\u8BED\u8A00\u5305\u540E\u70B9\u51FB\u300C\u5E94\u7528\u66F4\u65B0\u5E76\u5BF9\u6BD4\u300D\uFF0C\u8FD9\u91CC\u4F1A\u9010\u6837\u4F8B\u5217\u51FA\uFF1A\u54EA\u4E9B\u6E32\u67D3\u6587\u5B57\u53D8\u4E86\uFF0C\u54EA\u4E9B\u6587\u5B57\u76F8\u540C\u4F46\u771F\u5B9E\u6765\u6E90\u53D8\u4E86\uFF08\u4F8B\u5982\u8865\u4E0A\u672C\u5730\u53E5\u5F0F\u540E\u4E0D\u518D\u56DE\u9000\uFF09\u3002"
      )
    );
  }

  // src/ui/main.ts
  var app = document.getElementById("app");
  if (!app) throw new Error("#app root not found");
  var state = createInitialState();
  var HASH_TABS = ["play", "qa", "diff"];
  var initialHash = window.location.hash.replace("#", "");
  if (HASH_TABS.includes(initialHash)) state.tab = initialHash;
  window.addEventListener("hashchange", () => {
    const t = window.location.hash.replace("#", "");
    if (HASH_TABS.includes(t) && t !== state.tab) ctx.update({ tab: t });
  });
  var tabRoot;
  var navRoot;
  var controlsRoot;
  function renderActiveTab() {
    clear(tabRoot);
    if (state.tab === "play") tabRoot.appendChild(renderPlayTab(ctx));
    if (state.tab === "qa") tabRoot.appendChild(renderQaTab(ctx));
    if (state.tab === "diff") tabRoot.appendChild(renderDiffTab(ctx));
    renderNav();
  }
  function renderControls() {
    clear(controlsRoot);
    controlsRoot.appendChild(Controls());
  }
  var ctx = {
    state,
    update(patch) {
      Object.assign(state, patch);
      if (patch.tab) {
        const hash = `#${patch.tab}`;
        if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
      }
      renderControls();
      renderActiveTab();
    },
    rerender: renderActiveTab
  };
  function renderNav() {
    const tabs = [
      { id: "play", label: "\u2460 \u8BD5\u73A9 / \u6279\u91CF\u9884\u6F14" },
      {
        id: "qa",
        label: "\u2461 \u8D28\u68C0\u6E05\u5355",
        badge: String(state.issues.filter((i) => i.severity === "error").length)
      },
      { id: "diff", label: "\u2462 \u66F4\u65B0\u8BED\u8A00\u5305\u5BF9\u6BD4" }
    ];
    clear(navRoot);
    for (const t of tabs) {
      navRoot.appendChild(
        h(
          "button",
          {
            class: `tab-btn ${state.tab === t.id ? "tab-active" : ""}`,
            onclick: () => ctx.update({ tab: t.id })
          },
          t.label,
          t.badge && t.badge !== "0" ? h("span", { class: "tab-badge" }, t.badge) : null
        )
      );
    }
  }
  function Controls() {
    const countInput = h("input", {
      id: "ctrl-count",
      type: "number",
      min: "0",
      step: "1",
      value: state.count,
      oninput: (e) => {
        const v = Number(e.target.value);
        state.count = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
        renderActiveTab();
      }
    });
    const preset = (n, label) => h("button", {
      class: `btn btn-preset ${state.count === n ? "preset-active" : ""}`,
      dataset: { count: String(n) },
      onclick: () => ctx.update({ count: n })
    }, label ?? String(n));
    return h(
      "section",
      { class: "controls card" },
      h(
        "div",
        { class: "ctrl-group" },
        h("label", { class: "ctrl-label" }, "\u9884\u89C8\u8BED\u8A00"),
        h(
          "select",
          {
            value: state.locale,
            onchange: (e) => ctx.update({ locale: e.target.value })
          },
          ...LOCALE_ORDER.map((l) => h("option", { value: l, selected: l === state.locale }, state.packs[l]?.label ?? l))
        )
      ),
      h(
        "div",
        { class: "ctrl-group" },
        h("label", { class: "ctrl-label" }, "\u89D2\u8272\uFF08\u51B3\u5B9A\u79F0\u547C\u53E5\u5F0F\uFF09"),
        h(
          "select",
          {
            onchange: (e) => ctx.update({ characterId: e.target.value })
          },
          ...state.characters.map(
            (c) => h(
              "option",
              { value: c.id, selected: c.id === state.characterId },
              `${c.name[state.locale] ?? c.name["zh-CN"]} \xB7 ${state.packs[state.locale]?.terms.address[c.address] ?? c.address}\u79F0\u547C`
            )
          )
        )
      ),
      h(
        "div",
        { class: "ctrl-group" },
        h("label", { class: "ctrl-label" }, "\u7269\u54C1\uFF08\u51B3\u5B9A\u7C7B\u522B\u53E5\u5F0F\uFF09"),
        h(
          "select",
          {
            onchange: (e) => ctx.update({ itemId: e.target.value })
          },
          ...state.items.map(
            (i) => h(
              "option",
              { value: i.id, selected: i.id === state.itemId },
              `${i.name[state.locale] ?? i.name["zh-CN"]} \xB7 ${categoryLabel(i.category, state.locale)}`
            )
          )
        )
      ),
      h(
        "div",
        { class: "ctrl-group ctrl-count" },
        h("label", { class: "ctrl-label" }, "\u6570\u91CF\uFF08\u6279\u91CF\u8986\u76D6\uFF09"),
        h("div", { class: "count-row" }, countInput, preset(0), preset(1), preset(2, "2+"), preset(5))
      )
    );
  }
  app.appendChild(
    h(
      "header",
      { class: "site-header" },
      h(
        "div",
        null,
        h("h1", null, "\u300A\u661F\u6E2F\u6742\u8D27\u94FA\u300B\u6587\u6848\u4E0A\u4E0B\u6587\u68C0\u67E5\u53F0"),
        h("p", { class: "subtitle" }, "\u6570\u91CF \xB7 \u79F0\u547C\u5BF9\u8C61 \xB7 \u7269\u54C1\u7C7B\u522B\u9A71\u52A8\u7684\u591A\u53E5\u5F0F\u8BED\u8A00\u5305\u68C0\u67E5 / \u8BD5\u73A9 / \u56DE\u9000\u6EAF\u6E90 / \u66F4\u65B0\u5BF9\u6BD4\uFF08\u7EAF\u672C\u5730\u865A\u6784\u6837\u4F8B\uFF09")
      ),
      h("span", { class: "offline-badge", title: "\u6240\u6709\u8D44\u6E90\u4E0E\u8BA1\u7B97\u5747\u5728\u672C\u5730\uFF0C\u65E0\u4EFB\u4F55\u7F51\u7EDC\u8BF7\u6C42" }, "\u25CF \u79BB\u7EBF\u53EF\u7528")
    )
  );
  controlsRoot = h("div", { class: "controls-slot" });
  app.appendChild(controlsRoot);
  renderControls();
  navRoot = h("nav", { class: "tabs" });
  app.appendChild(navRoot);
  tabRoot = h("main", { class: "tab-root" });
  app.appendChild(tabRoot);
  app.appendChild(
    h(
      "footer",
      { class: "site-footer" },
      "\u9ED8\u8BA4\u6837\u4F8B\u5185\u7F6E\u4E86\uFF1A\u6F0F\u653E\u53D8\u91CF\u3001\u62FC\u9519\u7684\u591A\u51FA\u53D8\u91CF\u3001\u6574\u6570\u7C7B\u578B\u9519\u8BEF\u3001\u6F0F\u4F20\u53D8\u91CF\u503C\u3001\u672A\u8D70\u5230\u7684\u53E5\u5F0F\uFF0C\u4EE5\u53CA\u540C\u8BED\u8A00\u901A\u7528\u53E5 / \u8DE8\u8BED\u8A00\u4E24\u79CD\u56DE\u9000\u3002\u547D\u4EE4\u884C\u8FD0\u884C ",
      h("code", null, "npm run qa"),
      " \u53EF\u79BB\u7EBF\u751F\u6210 qa-checklist.md\u3002"
    )
  );
  renderActiveTab();
})();
