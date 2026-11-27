// 处理报告的中文说明映射。报告只展示类别、标签名、属性名与截断后的
// 安全文本片段,所有数据在 UI 中一律以 textContent 写入,
// 原始危险标记不会作为可执行页面内容重新出现。

export const REASON_LABELS = {
  // 元素移除
  'dangerous-subtree': '危险元素及其全部内容被整体移除(脚本/嵌入/画布等)',
  'tag-not-allowed': '不在白名单内的标签被移除,子内容保留',
  // 属性移除
  'event-handler': '事件处理属性(on*)被移除,脚本无法触发',
  'attribute-not-allowed': '不在白名单内的属性被移除',
  'namespaced-attribute': '命名空间/私有前缀属性被移除',
  'target-not-allowed': 'target 属性被移除,禁止新窗口/弹窗导航',
  'style-fully-removed': '内联样式全部不合规,整个 style 属性被移除',
  // URL 类
  'url:script-scheme': '脚本协议地址(javascript/vbscript 等)被拒绝',
  'url:network-request-blocked-by-policy': '外部网络地址被策略拒绝,预览不发起任何外联请求',
  'url:protocol-relative-url': '协议相对地址(//host)被拒绝',
  'url:backslash-obfuscation': '反斜杠混淆地址被拒绝',
  'url:scheme-not-allowed': '非白名单协议地址被拒绝',
  'url:data-uri-type-not-allowed': 'data: URI 的媒体类型不在允许的图片类型内',
  'url:data-uri-must-be-base64': 'data: 图片必须使用 base64 编码',
  'url:data-uri-bad-payload': 'data: URI 载荷含非法字符',
  'url:data-uri-malformed': 'data: URI 格式不完整',
  'url:relative-link-not-resolvable-in-sandbox': '相对链接在隔离帧中无法解析,已拒绝',
  'url:relative-resource-blocked': '相对路径资源被拒绝,隔离帧不加载任何外部资源',
  'url:empty-url': '空地址被拒绝',
  'url:unparseable-url': '无法解析的地址被拒绝',
  'url:fragment-not-allowed-as-resource': '锚点不能作为资源地址',
  'url:blob-uri-not-allowed': 'blob: 地址被拒绝',
  'url:filesystem-uri-not-allowed': 'filesystem: 地址被拒绝',
  // CSS
  'css-url-reference': 'CSS 值中的 url() 引用被移除',
  'css-at-import': 'CSS @import 外联被移除',
  'css-expression': 'CSS expression() 脚本表达式被移除',
  'css-script-scheme': 'CSS 值中的脚本协议被移除',
  'css-data-uri': 'CSS 值中的 data: URI 被移除',
  'css-markup-chars': 'CSS 值中夹带标记字符,声明被移除',
  'css-backslash-escape': 'CSS 反斜杠转义可能隐藏载荷,声明被移除',
  'property-not-allowed': '不在白名单内的 CSS 属性被移除',
  'custom-property-not-allowed': 'CSS 自定义属性(--*)被移除',
  'invalid-property-name': '非法 CSS 属性名,声明被移除',
  'malformed-declaration': '畸形 CSS 声明被移除',
  'empty-value': '空值 CSS 声明被移除',
  'unbalanced-quotes': '引号不配对的 CSS 声明被移除',
  // 解析器
  'unclosed-rawtext': '原始文本元素未闭合,已容错处理',
  'unterminated-comment': '注释未闭合,已丢弃',
  'unterminated-declaration': '声明未闭合,已丢弃',
  'unterminated-attribute-value': '属性值引号未闭合,已容错处理',
  'unterminated-start-tag': '开始标签未闭合,已容错处理',
  'unterminated-end-tag': '结束标签未闭合,已容错处理',
  'malformed-attribute': '畸形属性片段被跳过',
  'malformed-start-tag': '畸形开始标签被容错处理',
  'malformed-end-tag': '畸形结束标签被容错处理',
  'duplicate-attribute': '重复属性按浏览器规则只保留第一个',
  'attributes-on-end-tag': '结束标签上的属性被忽略',
  'stray-end-tag': '多余的结束标签被忽略',
  'self-closing-on-non-void': '非空元素的自闭合斜杠按浏览器规则忽略',
  'unclosed-elements': '文档结束时仍有未闭合元素,已自动闭合',
  'comment-or-declaration-removed': '注释/DOCTYPE/处理指令不进入预览',
  'ok': '符合策略,保留'
};

export function reasonText(code) {
  return REASON_LABELS[code] || code;
}

export const ELEMENT_REASON_TONE = {
  'dangerous-subtree': 'danger',
  'tag-not-allowed': 'warn'
};
