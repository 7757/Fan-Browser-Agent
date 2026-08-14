// SHC-3:Node 侧内容序列化器复用 content-extractor 的 markdown 后处理(单向依赖,后者不 require 本文件)。
const { preprocessMarkdownContent } = require('./content-extractor.cjs')
const {
  autocompleteMetadataFor,
  withAutocompleteSemantics
} = require('./autocomplete-semantics.cjs')

const INTERACTIVE_TAGS = new Set(['a', 'button', 'details', 'input', 'option', 'optgroup', 'select', 'summary', 'textarea'])
const INTERACTIVE_ROLES = new Set([
  'button',
  'cell',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'row',
  'search',
  'searchbox',
  'slider',
  'spinbutton',
  'tab',
  'textbox'
])
const SEARCH_INDICATORS = [
  'search',
  'magnify',
  'glass',
  'lookup',
  'find',
  'query',
  'search-icon',
  'search-btn',
  'search-button',
  'searchbox'
]

const PROPAGATING_ELEMENTS = [
  { tag: 'a', role: null },
  { tag: 'button', role: null },
  { tag: 'div', role: 'button' },
  { tag: 'div', role: 'combobox' },
  { tag: 'span', role: 'button' },
  { tag: 'span', role: 'combobox' },
  { tag: 'input', role: 'combobox' }
]

const FORM_ELEMENT_TAGS = new Set(['input', 'select', 'textarea', 'label'])
const INDEPENDENT_INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option'])
// These nodes contain browser/program payloads rather than page semantics.
// Skipping only their own tag line is not enough: DOMSnapshot represents the
// source as child text nodes, which previously leaked minified scripts/styles
// (especially from attached third-party frames) into the model observation.
// This is deliberately a semantic subtree filter, not viewport cropping: all
// meaningful document content and numbered controls remain serializable.
const MODEL_SNAPSHOT_SKIP_SUBTREE_TAGS = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template'
])
const BROWSER_USE_INCLUDE_ATTRIBUTES = [
  'title',
  'type',
  'checked',
  'id',
  'name',
  'role',
  'value',
  'placeholder',
  'data-date-format',
  'alt',
  'aria-label',
  'aria-expanded',
  'data-state',
  'aria-checked',
  'aria-valuemin',
  'aria-valuemax',
  'aria-valuenow',
  'aria-placeholder',
  'pattern',
  'min',
  'max',
  'minlength',
  'maxlength',
  'step',
  'accept',
  'multiple',
  'inputmode',
  'autocomplete',
  'aria-autocomplete',
  'aria-haspopup',
  'aria-controls',
  'aria-owns',
  'aria-activedescendant',
  'list',
  'data-mask',
  'data-inputmask',
  'data-datepicker',
  'format',
  'expected_format',
  'contenteditable',
  'pseudo',
  'selected',
  'expanded',
  'pressed',
  'disabled',
  'invalid',
  'valuemin',
  'valuemax',
  'valuenow',
  'keyshortcuts',
  'haspopup',
  'multiselectable',
  'required',
  'valuetext',
  'level',
  'busy',
  'live'
  // 'ax_name' 已移出序列化白名单:不发这个合成的 AX 可达名(只发真实 HTML 属性如 alt/aria-label)。
  // ax_name 仍保留在节点属性上供【文本源】(browserUseTextNode :883,给无文字图标按钮当文字标签)与交互判定使用。
]
const OBSERVE_COMPUTED_STYLES = [
  'cursor',
  'display',
  'visibility',
  'opacity',
  'background-color',
  'overflow',
  'overflow-x',
  'overflow-y',
  'pointer-events',
  'position'
]
const PASSWORD_VALUE_MARKER = '[password-populated]'
const PASSWORD_VALUE_ATTRIBUTE_NAMES = new Set([
  'value',
  'valuetext',
  'valuenow',
  'aria-valuetext',
  'aria-valuenow'
])

function isPasswordInput(tag, attributes = {}) {
  return String(tag || '').toLowerCase() === 'input' &&
    String(attributes.type || '').trim().toLowerCase() === 'password'
}

function collectPasswordSensitiveValues(attributes = {}, ...values) {
  const sensitiveValues = new Set()
  for (const [name, value] of Object.entries(attributes)) {
    if (!PASSWORD_VALUE_ATTRIBUTE_NAMES.has(String(name).toLowerCase())) continue
    if (value != null && String(value) !== '' && String(value) !== PASSWORD_VALUE_MARKER) {
      sensitiveValues.add(String(value))
    }
  }
  for (const value of values) {
    if (value != null && String(value) !== '' && String(value) !== PASSWORD_VALUE_MARKER) {
      sensitiveValues.add(String(value))
    }
  }
  return sensitiveValues
}

function redactPasswordString(value, sensitiveValues) {
  if (value == null) return value
  return sensitiveValues.has(String(value)) ? PASSWORD_VALUE_MARKER : value
}

function scrubSensitiveControlAttributes(
  tag,
  attributes = {},
  populated = undefined,
  sensitiveValues = collectPasswordSensitiveValues(attributes)
) {
  if (!isPasswordInput(tag, attributes)) return attributes
  const hasStaticValue = Object.entries(attributes).some(([name, value]) => (
    PASSWORD_VALUE_ATTRIBUTE_NAMES.has(String(name).toLowerCase()) &&
    value != null &&
    String(value) !== ''
  ))
  const hasValue = typeof populated === 'boolean' ? populated : hasStaticValue
  for (const name of Object.keys(attributes)) {
    if (PASSWORD_VALUE_ATTRIBUTE_NAMES.has(String(name).toLowerCase())) {
      delete attributes[name]
      continue
    }
    attributes[name] = redactPasswordString(attributes[name], sensitiveValues)
  }
  if (hasValue) attributes.value = PASSWORD_VALUE_MARKER
  return attributes
}

function snapshotCaptureParams() {
  return {
    computedStyles: OBSERVE_COMPUTED_STYLES,
    includeDOMRects: true,
    includePaintOrder: true
  }
}

function snapshotDocumentUrls(snapshot = {}) {
  const strings = snapshot?.strings || []
  const urls = new Set()
  for (const document of snapshot?.documents || []) {
    const index = document?.documentURL
    if (typeof index !== 'number') continue
    const url = strings[index]
    if (url) urls.add(String(url))
  }
  return urls
}

function snapshotBelongsToTarget(snapshot, targetUrl = '') {
  const expected = String(targetUrl || '').split('#')[0]
  if (!expected) return true
  const urls = snapshotDocumentUrls(snapshot)
  if (!urls.size) return true
  for (const url of urls) {
    if (String(url).split('#')[0] === expected) return true
  }
  return false
}
function readString(strings, value) {
  if (typeof value !== 'number') return ''
  return strings[value] || ''
}

function parseAttributes(strings, raw = []) {
  const attributes = {}
  if (!Array.isArray(raw)) return attributes
  for (let index = 0; index < raw.length - 1; index += 2) {
    const name = readString(strings, raw[index])
    if (!name) continue
    attributes[name] = readString(strings, raw[index + 1])
  }
  return attributes
}

function parseRareString(strings, rare, nodeIndex) {
  if (!rare || !Array.isArray(rare.index) || !Array.isArray(rare.value)) return ''
  const rareIndex = rare.index.indexOf(nodeIndex)
  if (rareIndex < 0) return ''
  return readString(strings, rare.value[rareIndex])
}

function parseRareValue(rare, nodeIndex) {
  if (Array.isArray(rare)) return rare[nodeIndex]
  if (!rare || !Array.isArray(rare.index) || !Array.isArray(rare.value)) return undefined
  const rareIndex = rare.index.indexOf(nodeIndex)
  if (rareIndex < 0) return undefined
  return rare.value[rareIndex]
}

function hasRareValue(rare, nodeIndex) {
  if (Array.isArray(rare)) return nodeIndex >= 0 && nodeIndex < rare.length
  return Boolean(rare && Array.isArray(rare.index) && rare.index.includes(nodeIndex))
}

function parseRareBoolean(rare, nodeIndex) {
  return Boolean(rare && Array.isArray(rare.index) && rare.index.includes(nodeIndex))
}

function applyLiveFormState(nodes, nodeIndex, tag, attributes) {
  const type = String(attributes.type || '').toLowerCase()
  if (tag === 'input' && (type === 'checkbox' || type === 'radio') && nodes.inputChecked) {
    if (parseRareBoolean(nodes.inputChecked, nodeIndex)) attributes.checked = 'true'
    else delete attributes.checked
  }
  if (tag === 'option' && nodes.optionSelected) {
    if (parseRareBoolean(nodes.optionSelected, nodeIndex)) attributes.selected = 'true'
    else delete attributes.selected
  }
}

function compact(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function structuredElementFieldsFor(
  tag,
  attributes = {},
  { accessibilityName = '', liveValue = undefined, capabilities = undefined } = {}
) {
  const normalizedTag = String(tag || '').toLowerCase()
  const explicitType = String(attributes.type || '').toLowerCase()
  const type = normalizedTag === 'input' && !explicitType ? 'text' : explicitType
  const fields = { type }

  // `name` is the accessible name exposed to program filters. The HTML form
  // name remains available as attributes.name and must not outrank a real
  // label such as aria-label="Card number".
  const name = compact(attributes.ax_name || accessibilityName || attributes['aria-label'] || '', 500)
  if (name) fields.name = name

  const passwordInput = isPasswordInput(normalizedTag, attributes)
  const rawValue = liveValue != null ? liveValue : attributes.value
  const value = passwordInput && rawValue != null && String(rawValue) !== ''
    ? PASSWORD_VALUE_MARKER
    : rawValue
  if (value != null) fields.value = String(value)

  const checkedValue = attributes.checked ?? attributes['aria-checked']
  const checkableInput = normalizedTag === 'input' && (type === 'checkbox' || type === 'radio')
  if (checkableInput || checkedValue != null) {
    const normalizedChecked = String(checkedValue ?? '').trim().toLowerCase()
    fields.checked = checkedValue != null && !['false', '0', 'no', 'off'].includes(normalizedChecked)
  }

  const autocomplete = autocompleteMetadataFor({
    tag: normalizedTag,
    type,
    role: attributes.role,
    attributes,
    capabilities
  })
  if (autocomplete.detected) fields.autocomplete = autocomplete

  return fields
}

function textFor(strings, nodes, nodeIndex, tag, attributes, sensitiveValues = new Set()) {
  const passwordInput = isPasswordInput(tag, attributes)
  // 输入控件的【已输入值】(DOMSnapshot inputValue)优先于 placeholder/aria-label:否则用户输入的
  // 文本被 placeholder 盖住,模型看不见自己输入了什么(最初"假输入"困惑的直接根因)。
  // Password values are represented only by a fixed populated marker.
  const inputValue = compact(parseRareString(strings, nodes.inputValue, nodeIndex) || '')
  if (inputValue && !passwordInput) return inputValue
  const attributeNames = passwordInput
    ? ['aria-label', 'placeholder', 'title', 'alt', 'name']
    : ['aria-label', 'placeholder', 'title', 'alt', 'value', 'name']
  for (const name of attributeNames) {
    if (attributes[name]) {
      return compact(passwordInput
        ? redactPasswordString(attributes[name], sensitiveValues)
        : attributes[name])
    }
  }
  if (passwordInput && attributes.value === PASSWORD_VALUE_MARKER) {
    return PASSWORD_VALUE_MARKER
  }
  const nodeValue = parseRareString(strings, nodes.nodeValue, nodeIndex) || ''
  return compact(passwordInput ? redactPasswordString(nodeValue, sensitiveValues) : nodeValue)
}

// DOMSnapshot 的 layout bounds 是【设备像素】(deviceScaleFactor 倍),与页面 CSS 像素差 DPR 倍。
// 照搬 enhanced_snapshot.py:117-127:除以 devicePixelRatio 归一到 CSS 像素,
// 让 paint-order 遮挡 / containment / 视口可见性 / icon 尺寸阈值 / 高亮 / 去重键 全部在同一 CSS 坐标系。
function rectFromBounds(raw, dpr = 1) {
  if (!Array.isArray(raw) || raw.length < 4) return null
  const d = Number(dpr) > 0 ? Number(dpr) : 1
  const [x, y, width, height] = raw.map(v => Number(v) / d)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width <= 0 || height <= 0) return null
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x
  }
}

function rectFromOptionalBounds(raw, dpr = 1) {
  if (!Array.isArray(raw) || raw.length < 4) return null
  const d = Number(dpr) > 0 ? Number(dpr) : 1
  const [x, y, width, height] = raw.map(v => Number(v) / d)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x
  }
}

function buildLayoutLookup(document, strings, styleNames = [], dpr = 1) {
  const lookup = new Map()
  const layout = document.layout || {}
  const nodeIndexes = layout.nodeIndex || []
  const bounds = layout.bounds || []
  const clientRects = layout.clientRects || []
  const scrollRects = layout.scrollRects || []
  const paintOrders = layout.paintOrders || []
  const text = layout.text || []
  const styles = layout.styles || []
  for (let index = 0; index < nodeIndexes.length; index += 1) {
    const computedStyles = {}
    const styleValues = styles[index] || []
    for (let styleIndex = 0; styleIndex < styleNames.length; styleIndex += 1) {
      computedStyles[styleNames[styleIndex]] = readString(strings, styleValues[styleIndex])
    }
    lookup.set(nodeIndexes[index], {
      bounds: rectFromBounds(bounds[index], dpr),
      clientRects: rectFromOptionalBounds(clientRects[index], dpr),
      scrollRects: rectFromOptionalBounds(scrollRects[index], dpr),
      computedStyles,
      paintOrder: paintOrders[index],
      textIndex: text[index]
    })
  }
  return lookup
}

function hasFormControlDescendant(node, maxDepth = 2) {
  if (!node || maxDepth <= 0) return false
  for (const child of node.children || []) {
    if (!child || child.nodeType !== 1) continue
    if (['input', 'select', 'textarea'].includes(child.tag)) return true
    if (hasFormControlDescendant(child, maxDepth - 1)) return true
  }
  return false
}

function hasSearchIndicator(attributes = {}) {
  const className = String(attributes.class || '').toLowerCase()
  const id = String(attributes.id || '').toLowerCase()
  if (SEARCH_INDICATORS.some(indicator => className.includes(indicator) || id.includes(indicator))) return true
  for (const [name, value] of Object.entries(attributes)) {
    if (!String(name).startsWith('data-')) continue
    const normalized = String(value || '').toLowerCase()
    if (SEARCH_INDICATORS.some(indicator => normalized.includes(indicator))) return true
  }
  return false
}

const DISABLED_CLASS_NAMES = new Set([
  'disabled',
  'is-disabled',
  'is_disabled',
  'unavailable',
  'ui-state-disabled',
  'ui-datepicker-unselectable',
  'ant-picker-cell-disabled',
  'mui-disabled',
  'flatpickr-disabled',
  'react-datepicker__day--disabled'
])

function attributesSignalDisabled(attributes = {}) {
  if (attributes.disabled != null || attributes.inert != null) return true
  if (String(attributes['aria-disabled'] || '').toLowerCase() === 'true') return true
  const dataDisabled = String(attributes['data-disabled'] || '').toLowerCase()
  if (dataDisabled === '' && attributes['data-disabled'] != null) return true
  if (dataDisabled === 'true') return true
  const classes = String(attributes.class || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return classes.some(className => (
    DISABLED_CLASS_NAMES.has(className) ||
    /(?:^|[-_])disabled(?:$|[-_])/.test(className)
  ))
}

function attributesSignalReadOnly(attributes = {}) {
  if (attributes.readonly != null) {
    const readonly = String(attributes.readonly).trim().toLowerCase()
    if (!['false', '0', 'no', 'off'].includes(readonly)) return true
  }
  if (String(attributes['aria-readonly'] || '').trim().toLowerCase() === 'true') return true
  if (String(attributes.contenteditable ?? '').trim().toLowerCase() === 'false') return true
  return false
}

function attributesSignalEditable(attributes = {}, tag = '') {
  if (attributesSignalReadOnly(attributes)) return false
  if (attributes.contenteditable != null) {
    const contenteditable = String(attributes.contenteditable).trim().toLowerCase()
    return contenteditable === '' || contenteditable === 'true' || contenteditable === 'plaintext-only'
  }
  // Chromium's AX tree exposes computed editability as a token
  // (`plaintext`/`richtext`), not merely a boolean. Keep `true` for defensive
  // compatibility with older/synthetic trees.
  const axEditable = ['true', 'plaintext', 'richtext'].includes(
    String(attributes.editable ?? '').trim().toLowerCase()
  )
  if (!axEditable) return false
  // AX editability is inherited by descendants of a rich-text editor. It is
  // therefore evidence only for a real editor root: the document BODY (for
  // designMode editors) or an explicit textbox/searchbox role. Paragraphs and
  // spans inside that editor must not each receive their own action number.
  const role = String(attributes.role || '').trim().toLowerCase()
  return String(tag || '').toLowerCase() === 'body' || role === 'textbox' || role === 'searchbox'
}

function attributesSignalEditorHost(attributes = {}, tag = '') {
  const role = String(attributes.role || '').trim().toLowerCase()
  return (
    attributes.contenteditable != null ||
    role === 'textbox' ||
    role === 'searchbox' ||
    attributesSignalEditable(attributes, tag) ||
    attributesSignalReadOnly(attributes)
  )
}

function isInteractiveNode({ attributes, layoutInfo, tag, node = null }) {
  if (!tag || tag === 'html') return false
  const editableContentHost = attributesSignalEditable(attributes, tag)
  // Ordinary document roots stay pruned, but editors such as TinyMCE can make
  // the BODY itself the actual contenteditable typing target.
  if (tag === 'body' && !editableContentHost) return false
  // JS 点击监听器 = 最高优先级可交互信号(对齐 clickable_elements.py:41-42),
  // 必须在可见性否决【之前】判,否则带监听器的控件会被 hidden/aria-hidden 误杀。truly-hidden
  // 的元素仍由下游 visible(:1603 !isHiddenByStyle, display:none/visibility/opacity)过滤掉。
  if (node?.hasJsClickListener) return true
  // `hidden`/`aria-hidden` are genuinely invisible → drop. But DISABLED controls
  // are kept and flagged (node.disabled → serialized as 'disabled', :639) so the
  // model can SEE a form's gating (e.g. a disabled Submit) instead of the element
  // vanishing — clicking a disabled control is a harmless no-op.
  if (attributes.hidden != null) return false
  if (attributes['aria-hidden'] === 'true') return false
  if ((tag === 'iframe' || tag === 'frame') && layoutInfo?.bounds?.width > 100 && layoutInfo?.bounds?.height > 100) return true
  if (tag === 'label') {
    if (attributes.for != null) return false
    if (node && hasFormControlDescendant(node, 2)) return true
  }
  if (tag === 'span' && node && hasFormControlDescendant(node, 2)) return true
  if (INTERACTIVE_TAGS.has(tag)) return true
  // Semantically described images are legitimate pointer targets even when
  // they are not clickable:
  // galleries, product previews, maps and profile cards commonly reveal their
  // only useful controls/text on CSS :hover. Number visible images so a program
  // can point at the exact image from the current snapshot instead of guessing
  // coordinates or relying on an accidental small-icon heuristic. Empty-alt
  // decorative images stay pruned, while existing parent containment pruning
  // removes duplicate image refs inside links/buttons and leaves the actionable
  // parent as the single target.
  if (
    tag === 'img' &&
    [attributes.alt, attributes.title, attributes['aria-label']]
      .some(value => String(value || '').trim())
  ) return true
  if (editableContentHost) return true
  if (hasSearchIndicator(attributes)) return true
  if (INTERACTIVE_ROLES.has(String(attributes.role || '').toLowerCase())) return true
  // AX 树的可聚焦/可编辑/可设值(对齐 clickable_elements.py:118-128)。
  // 注:focusable=false/editable=false 这类负向值不触发(axValue 把布尔转成 'true'/'false' 字符串)。
  if (attributes.focusable === 'true' || attributes.settable === 'true') return true
  if (attributes.onclick != null || attributes.onmousedown != null || attributes.onmouseup != null) return true
  if (attributes.onkeydown != null || attributes.onkeyup != null) return true
  if (attributes.tabindex != null && attributes.tabindex !== '-1') return true
  if (attributes['aria-expanded'] != null || attributes['aria-pressed'] != null || attributes['aria-checked'] != null || attributes['aria-selected'] != null) return true
  // AX 树折叠进 attributes 的交互态属性「存在即交互」(对齐 clickable_elements.py:121-132):
  // checked/expanded/pressed/selected/required/keyshortcuts 的存在表明这是个有状态的交互控件
  // (捕获 HTML 上没写 aria-* 但 AX 计算出状态的自定义控件)。
  if (attributes.checked != null || attributes.expanded != null || attributes.pressed != null ||
      attributes.selected != null || attributes.required === 'true' || attributes.keyshortcuts != null) return true
  const bounds = layoutInfo?.bounds
  if (
    bounds &&
    bounds.width >= 10 &&
    bounds.width <= 50 &&
    bounds.height >= 10 &&
    bounds.height <= 50 &&
    (attributes.class != null || attributes.role != null || attributes.onclick != null || attributes['data-action'] != null || attributes['aria-label'] != null)
  ) {
    return true
  }
  if (layoutInfo?.computedStyles?.cursor === 'pointer') return true
  return false
}

function isScrollableByLayout(tag, layoutInfo = {}) {
  const scrollRects = layoutInfo.scrollRects
  const clientRects = layoutInfo.clientRects
  if (!scrollRects || !clientRects) return false
  const hasVerticalScroll = Number(scrollRects.height || 0) > Number(clientRects.height || 0) + 1
  const hasHorizontalScroll = Number(scrollRects.width || 0) > Number(clientRects.width || 0) + 1
  if (!hasVerticalScroll && !hasHorizontalScroll) return false
  const styles = layoutInfo.computedStyles || {}
  const overflow = String(styles.overflow || 'visible').toLowerCase()
  const overflowX = String(styles['overflow-x'] || overflow).toLowerCase()
  const overflowY = String(styles['overflow-y'] || overflow).toLowerCase()
  const allowedValues = new Set(['auto', 'scroll', 'overlay'])
  if (allowedValues.has(overflow) || allowedValues.has(overflowX) || allowedValues.has(overflowY)) return true
  if (styles.overflow == null && styles['overflow-x'] == null && styles['overflow-y'] == null) {
    return new Set(['div', 'main', 'section', 'article', 'aside', 'body', 'html']).has(String(tag || '').toLowerCase())
  }
  return false
}

function scrollInfoFor(layoutInfo = {}) {
  const scrollRects = layoutInfo.scrollRects
  const clientRects = layoutInfo.clientRects
  if (!scrollRects || !clientRects) return null
  const scrollTop = Math.max(0, Number(scrollRects.y || 0))
  const scrollLeft = Math.max(0, Number(scrollRects.x || 0))
  const scrollableHeight = Math.max(0, Number(scrollRects.height || 0))
  const scrollableWidth = Math.max(0, Number(scrollRects.width || 0))
  const visibleHeight = Math.max(0, Number(clientRects.height || 0))
  const visibleWidth = Math.max(0, Number(clientRects.width || 0))
  const contentBelow = Math.max(0, scrollableHeight - visibleHeight - scrollTop)
  const contentRight = Math.max(0, scrollableWidth - visibleWidth - scrollLeft)
  const maxScrollTop = Math.max(0, scrollableHeight - visibleHeight)
  const maxScrollLeft = Math.max(0, scrollableWidth - visibleWidth)
  return {
    scrollTop,
    scrollLeft,
    scrollableHeight,
    scrollableWidth,
    visibleHeight,
    visibleWidth,
    contentAbove: scrollTop,
    contentBelow,
    contentLeft: scrollLeft,
    contentRight,
    verticalScrollPercentage: maxScrollTop > 0 ? Math.round((scrollTop / maxScrollTop) * 1000) / 10 : 0,
    horizontalScrollPercentage: maxScrollLeft > 0 ? Math.round((scrollLeft / maxScrollLeft) * 1000) / 10 : 0,
    pagesAbove: visibleHeight > 0 ? Math.round((scrollTop / visibleHeight) * 10) / 10 : 0,
    pagesBelow: visibleHeight > 0 ? Math.round((contentBelow / visibleHeight) * 10) / 10 : 0,
    totalPages: visibleHeight > 0 ? Math.round((scrollableHeight / visibleHeight) * 10) / 10 : 1,
    canScrollUp: scrollTop > 0,
    canScrollDown: contentBelow > 0,
    canScrollLeft: scrollLeft > 0,
    canScrollRight: contentRight > 0
  }
}

function scrollInfoTextFor(node) {
  if (!node) return ''
  if (node.tag === 'iframe' || node.tag === 'frame') return node.hasHiddenContent || node.hiddenElementsInfo?.length ? 'scroll' : ''
  const info = node.scrollInfo
  if (!info) return ''
  const parts = []
  if (info.scrollableHeight > info.visibleHeight) parts.push(`${info.pagesAbove.toFixed(1)} pages above, ${info.pagesBelow.toFixed(1)} pages below`)
  if (info.scrollableWidth > info.visibleWidth) parts.push(`horizontal ${Math.round(info.horizontalScrollPercentage)}%`)
  return parts.join(' ')
}

function capabilitiesFor(tag, attributes, layoutInfo = {}) {
  const type = String(attributes.type || '').toLowerCase()
  const role = String(attributes.role || '').toLowerCase()
  const disabled = attributesSignalDisabled(attributes)
  const readonly = attributesSignalReadOnly(attributes)
  const typeable =
    attributesSignalEditable(attributes, tag) ||
    tag === 'textarea' ||
    role === 'textbox' ||
    role === 'searchbox' ||
    (tag === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type))
  return {
    clickable: !disabled,
    typeable: typeable && !disabled && !readonly,
    selectable: tag === 'select' && !disabled,
    upload: tag === 'input' && type === 'file' && !disabled,
    scrollable: isScrollableByLayout(tag, layoutInfo)
  }
}

function isPropagatingElement(node) {
  if (!node || !node.tag) return false
  const role = String(node.role || node.attributes?.role || '').toLowerCase() || null
  return PROPAGATING_ELEMENTS.some(pattern => {
    if (pattern.tag !== node.tag) return false
    if (pattern.role == null) return true
    return pattern.role === role
  })
}

function parentIndexesFor(nodes = {}) {
  if (Array.isArray(nodes.parentIndex)) return nodes.parentIndex
  if (Array.isArray(nodes.parentNodeIndex)) return nodes.parentNodeIndex
  return []
}

function nodeTypeName(type) {
  if (type === 1) return 'element'
  if (type === 3) return 'text'
  if (type === 9) return 'document'
  if (type === 11) return 'document-fragment'
  return 'node'
}

// 缺失的 opacity 计算样式不能当 opacity:0(Number('')===0 的坑会误隐藏丢号);
//只有真正存在且解析为 0 才算隐藏。
function _opacityHidden(styles) {
  const op = styles?.opacity
  return op != null && op !== '' && Number(op) === 0
}

function isHiddenByStyle(layoutInfo) {
  const styles = layoutInfo?.computedStyles || {}
  return styles.display === 'none' || styles.visibility === 'hidden' || _opacityHidden(styles)
}

function isCssHiddenNode(node) {
  const styles = node?.computedStyles || {}
  return styles.display === 'none' || styles.visibility === 'hidden' || _opacityHidden(styles)
}

function nodeText(
  strings,
  nodes,
  nodeIndex,
  tag,
  attributes,
  layoutInfo,
  accessibility = null,
  sensitiveValues = new Set()
) {
  const textFromLayout = readString(strings, layoutInfo?.textIndex)
  const passwordInput = isPasswordInput(tag, attributes)
  const text = textFor(strings, nodes, nodeIndex, tag, attributes, sensitiveValues) ||
    textFromLayout ||
    accessibility?.name ||
    ''
  return compact(passwordInput ? redactPasswordString(text, sensitiveValues) : text)
}

function optionTextFrom(node) {
  if (!node || node.tag !== 'option') return ''
  // DOMSnapshot often stores an <option>'s visible label only in a child
  // #text node. Falling straight back from node.text to value leaks opaque
  // codes such as "01" to the model instead of the label the user sees.
  return compact(snapshotTextContent(node) || node.text || node.attributes?.value || '', 80)
}

function optionTextsFrom(node, out = []) {
  if (!node || out.length >= 8) return out
  if (node.tag === 'option') {
    const text = optionTextFrom(node)
    if (text) out.push(text)
  }
  for (const child of node.children || []) {
    if (out.length >= 8) break
    optionTextsFrom(child, out)
  }
  return out
}

function selectedOptionTextFrom(node) {
  if (!node || node.tag !== 'select') return ''
  const options = []
  const collect = child => {
    if (!child) return
    if (child.tag === 'option') options.push(child)
    for (const grandchild of child.children || []) collect(grandchild)
  }
  for (const child of node.children || []) collect(child)
  const selected = options.find(option => option.attributes?.selected != null)
  const selectedText = optionTextFrom(selected)
  if (selectedText) return selectedText
  const liveValue = compact(node.liveValue || '', 500)
  if (liveValue) return liveValue
  const firstOptionText = optionTextFrom(options[0])
  if (firstOptionText) return firstOptionText
  return compact(node.value || node.attributes?.value || '', 500)
}

function compoundComponentsFor(node) {
  if (!node || !['input', 'select', 'details', 'audio', 'video'].includes(node.tag)) return []
  const attrs = node.attributes || {}
  const type = String(attrs.type || '').toLowerCase()
  if (node.tag === 'input') {
    if (['date', 'time', 'datetime-local', 'month', 'week'].includes(type)) return []
    if (type === 'range') {
      return [
        {
          role: 'slider',
          name: 'Value',
          valuemin: attrs.min || '0',
          valuemax: attrs.max || '100',
          valuenow: attrs.value || null
        }
      ]
    }
    if (type === 'number') {
      return [
        { role: 'button', name: 'Increment' },
        { role: 'button', name: 'Decrement' },
        { role: 'textbox', name: 'Value', valuemin: attrs.min || null, valuemax: attrs.max || null, valuenow: attrs.value || null }
      ]
    }
    if (type === 'color') {
      return [
        { role: 'textbox', name: 'Hex Value', valuenow: attrs.value || null },
        { role: 'button', name: 'Color Picker' }
      ]
    }
    if (type === 'file') {
      return [
        { role: 'button', name: 'Browse Files' },
        { role: 'textbox', name: attrs.multiple != null ? 'Files Selected' : 'File Selected', valuenow: attrs.value || 'None' }
      ]
    }
    return []
  }
  if (node.tag === 'select') {
    const options = optionTextsFrom(node, [])
    const components = [{ role: 'button', name: 'Dropdown Toggle' }]
    components.push({
      role: 'listbox',
      name: 'Options',
      optionsCount: options.length,
      firstOptions: options.slice(0, 4),
      valuenow: selectedOptionTextFrom(node) || null
    })
    return components
  }
  if (node.tag === 'details') {
    return [
      { role: 'button', name: 'Toggle Disclosure' },
      { role: 'region', name: 'Content Area' }
    ]
  }
  if (node.tag === 'audio') {
    return [
      { role: 'button', name: 'Play/Pause' },
      { role: 'slider', name: 'Progress', valuemin: 0, valuemax: 100 },
      { role: 'button', name: 'Mute' },
      { role: 'slider', name: 'Volume', valuemin: 0, valuemax: 100 }
    ]
  }
  if (node.tag === 'video') {
    return [
      { role: 'button', name: 'Play/Pause' },
      { role: 'slider', name: 'Progress', valuemin: 0, valuemax: 100 },
      { role: 'button', name: 'Mute' },
      { role: 'slider', name: 'Volume', valuemin: 0, valuemax: 100 },
      { role: 'button', name: 'Fullscreen' }
    ]
  }
  return []
}

function formatCompoundComponents(components = []) {
  const out = []
  for (const component of components) {
    const parts = []
    if (component.name) parts.push(`name=${component.name}`)
    if (component.role) parts.push(`role=${component.role}`)
    if (component.valuemin != null) parts.push(`min=${component.valuemin}`)
    if (component.valuemax != null) parts.push(`max=${component.valuemax}`)
    if (component.valuenow != null) parts.push(`current=${component.valuenow}`)
    if (component.optionsCount != null) parts.push(`count=${component.optionsCount}`)
    if (component.firstOptions?.length) parts.push(`options=${component.firstOptions.slice(0, 4).join('|')}`)
    if (component.formatHint) parts.push(`format=${component.formatHint}`)
    if (parts.length) out.push(`(${parts.join(',')})`)
  }
  return out.length ? `compound_components=${JSON.stringify(out.join(','))}` : ''
}

function semanticHeadingLevel(node) {
  const tagMatch = String(node?.tag || '').toLowerCase().match(/^h([1-6])$/)
  if (tagMatch) return Number(tagMatch[1])
  if (String(node?.role || node?.attributes?.role || '').toLowerCase() !== 'heading') return null
  const level = Number(node?.attributes?.level || node?.attributes?.['aria-level'])
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : null
}

function normalizedAttributeSourceFor(node) {
  const source = { ...(node.attributes || {}) }
  const tag = String(node.tag || '').toLowerCase()
  const type = String(source.type || '').toLowerCase()
  if (tag === 'input') {
    scrubSensitiveControlAttributes(tag, source)
    const formatMap = {
      date: 'YYYY-MM-DD',
      time: 'HH:MM',
      'datetime-local': 'YYYY-MM-DDTHH:MM',
      month: 'YYYY-MM',
      week: 'YYYY-W##'
    }
    if (formatMap[type]) {
      if (!source.format) source.format = formatMap[type]
      if (!source.placeholder) source.placeholder = formatMap[type]
    } else if (type === 'tel' && !source.placeholder && !source.pattern) {
      source.placeholder = '123-456-7890'
    } else if (type === 'text' || type === '') {
      const className = String(source.class || '').toLowerCase()
      const angularDateFormat = source['uib-datepicker-popup']
      const dataDateFormat = source['data-date-format']
      if (angularDateFormat) {
        source.expected_format = angularDateFormat
        source.format = source.format || angularDateFormat
      } else if (/(^|[-_\s])(date|datetime|daterange)picker($|[-_\s])/.test(className) || source['data-datepicker'] != null) {
        source.placeholder = source.placeholder || dataDateFormat || 'mm/dd/yyyy'
        source.format = source.format || dataDateFormat || 'mm/dd/yyyy'
      }
    }
  }
  if (source.type && String(source.type).toLowerCase() === tag) delete source.type
  if (String(source.invalid || '').toLowerCase() === 'false') delete source.invalid
  for (const name of ['required']) {
    const normalized = String(source[name] || '').toLowerCase()
    if (['false', '0', 'no'].includes(normalized)) delete source[name]
  }
  if (source.expanded != null && source['aria-expanded'] != null) delete source['aria-expanded']
  const headingLevel = semanticHeadingLevel(node)
  if (headingLevel) {
    if (!source.role) source.role = 'heading'
    if (!source.level) source.level = String(headingLevel)
  }
  return source
}

function displayAttributesFor(node) {
  const attrs = []
  const source = normalizedAttributeSourceFor(node)
  const includeAttributes = [
    'role',
    'type',
    'name',
    'placeholder',
    'aria-label',
    'title',
    'href',
    'value',
    'id',
    'checked',
    'selected',
    'multiple',
    'aria-expanded',
    'data-state',
    'aria-checked',
    'aria-valuemin',
    'aria-valuemax',
    'aria-valuenow',
    'aria-placeholder',
    'pattern',
    'min',
    'max',
    'minlength',
    'maxlength',
    'step',
    'accept',
    'inputmode',
    'autocomplete',
    'aria-autocomplete',
    'aria-haspopup',
    'aria-controls',
    'aria-owns',
    'aria-activedescendant',
    'list',
    'data-date-format',
    'data-mask',
    'data-inputmask',
    'data-datepicker',
    'format',
    'expected_format',
    'contenteditable',
    'pseudo',
    'expanded',
    'pressed',
    'invalid',
    'valuemin',
    'valuemax',
    'valuenow',
    'keyshortcuts',
    'haspopup',
    'multiselectable',
    'required',
    'valuetext',
    'level',
    'busy',
    'live',
    'ax_name',
    'alt'
  ]
  for (const name of includeAttributes) {
    const value = source[name]
    if (value == null || value === '') continue
    attrs.push(`${name}=${JSON.stringify(compact(value, name === 'href' ? 160 : 80))}`)
  }
  const autocomplete = autocompleteMetadataFor({
    tag: node.tag,
    role: node.role,
    attributes: source,
    capabilities: node.capabilities
  })
  if (autocomplete.detected) {
    attrs.push(`autocomplete_kind=${JSON.stringify(autocomplete.mode)}`)
  }
  if (node.capabilities?.scrollable) attrs.push('scrollable')
  if (node.disabled) attrs.push('disabled')
  if (node.readonly) attrs.push('readonly')
  if (node.tag === 'select') {
    const options = optionTextsFrom(node)
    if (options.length) attrs.push(`options=${JSON.stringify(options.join('|'))}`)
  }
  const compound = formatCompoundComponents(node.compoundComponents)
  if (compound) attrs.push(compound)
  return attrs.length ? ` ${attrs.join(' ')}` : ''
}

function browserUseAttributeEntriesFor(node, text = '') {
  const attributesToInclude = {}
  const source = normalizedAttributeSourceFor(node)

  for (const name of BROWSER_USE_INCLUDE_ATTRIBUTES) {
    const value = source[name]
    if (value == null || String(value).trim() === '') continue
    attributesToInclude[name] = String(value).trim()
  }

  if (node.disabled && attributesToInclude.disabled == null) attributesToInclude.disabled = 'true'

  const orderedKeys = []
  const seenKeys = new Set()
  for (const key of BROWSER_USE_INCLUDE_ATTRIBUTES) {
    if (attributesToInclude[key] == null || seenKeys.has(key)) continue
    orderedKeys.push(key)
    seenKeys.add(key)
  }

  if (orderedKeys.length > 1) {
    const keysToRemove = new Set()
    const seenValues = new Map()
    const protectedAttrs = new Set(['format', 'expected_format', 'placeholder', 'value', 'aria-label', 'title'])
    for (const key of orderedKeys) {
      const value = attributesToInclude[key]
      if (String(value).length <= 5) continue
      if (seenValues.has(value) && !protectedAttrs.has(key)) {
        keysToRemove.add(key)
      } else {
        seenValues.set(value, key)
      }
    }
    for (const key of keysToRemove) delete attributesToInclude[key]
  }

  if (attributesToInclude.role && String(attributesToInclude.role).toLowerCase() === String(node.tag || '').toLowerCase()) {
    delete attributesToInclude.role
  }
  // role=generic 是 AX 算出的"无语义容器"角色(裸 div/span),纯噪声;只发真实 HTML role、从不发
  // generic → 序列化层抑制掉。交互性判定在更早的 applyInteractiveDetection 读 attributes.role,不受此影响。
  if (String(attributesToInclude.role || '').toLowerCase() === 'generic') {
    delete attributesToInclude.role
  }
  if (attributesToInclude.type && String(attributesToInclude.type).toLowerCase() === String(node.tag || '').toLowerCase()) {
    delete attributesToInclude.type
  }
  if (String(attributesToInclude.invalid || '').toLowerCase() === 'false') delete attributesToInclude.invalid
  for (const attr of ['required']) {
    if (String(attributesToInclude[attr] || '').toLowerCase().match(/^(false|0|no)$/)) delete attributesToInclude[attr]
  }
  if (attributesToInclude.expanded != null && attributesToInclude['aria-expanded'] != null) delete attributesToInclude['aria-expanded']
  const normalizedText = String(text || '').trim().toLowerCase()
  if (normalizedText) {
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      if (String(attributesToInclude[attr] || '').trim().toLowerCase() === normalizedText) delete attributesToInclude[attr]
    }
  }

  const entries = []
  for (const key of orderedKeys) {
    if (attributesToInclude[key] == null) continue
    entries.push([key, compact(attributesToInclude[key], 100)])
  }

  const autocomplete = autocompleteMetadataFor({
    tag: node.tag,
    role: node.role,
    attributes: source,
    capabilities: node.capabilities
  })
  if (autocomplete.detected) {
    entries.push(['autocomplete_kind', autocomplete.mode])
  }

  const compound = formatCompoundComponents(node.compoundComponents)
  if (compound) {
    const value = compound.replace(/^compound_components=/, '')
    entries.push(['compound_components', value.replace(/^"|"$/g, '')])
  }

  return entries
}

function browserUseAttributesFor(node, text = '') {
  const entries = browserUseAttributeEntriesFor(node, text)
  if (!entries.length) return ''
  return entries.map(([key, value]) => (value ? `${key}=${value}` : `${key}=''`)).join(' ')
}

function shouldDisplayNode(node) {
  if (!node) return false
  if (MODEL_SNAPSHOT_SKIP_SUBTREE_TAGS.has(node.tag)) return false
  if (node.nodeType === 9 || node.tag === '#document') return false
  if (node.nodeType === 11 && node.shadowRootType) return true
  if (node.tag === 'html' || node.tag === 'body') {
    if (node.tag === 'body' && node.interactive && attributesSignalEditable(node.attributes, node.tag)) return true
    // A read-only rich-text editor body is page evidence even though it must
    // never receive an action number. Keep the explicit editor host and its
    // text visible without reintroducing ordinary document BODY noise.
    if (node.tag === 'body' && attributesSignalEditorHost(node.attributes, node.tag)) return true
    if ((node.tag === 'html' || node.tag === 'body') && node.interactive && node.capabilities?.scrollable) return true
    return false
  }
  if (node.isShadowHost) return true
  if (semanticHeadingLevel(node)) return true
  if (node.excludedByParent || node.ignoredByPaintOrder) return false
  if (node.interactive || node.tag === 'iframe' || node.tag === 'frame') return true
  const structuralTags = new Set(['main', 'nav', 'form', 'section', 'article', 'aside', 'header', 'footer', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'label'])
  return structuralTags.has(node.tag) && Boolean(node.text)
}

function hasDisplayDescendant(node) {
  if (!node || MODEL_SNAPSHOT_SKIP_SUBTREE_TAGS.has(node.tag)) return false
  return logicalChildrenFor(node).some(child => (
    !MODEL_SNAPSHOT_SKIP_SUBTREE_TAGS.has(child.tag) &&
    (child.shouldDisplay || child.hasDisplayDescendant)
  ))
}

function logicalChildrenFor(node) {
  if (!node) return []
  const children = Array.isArray(node.children) ? node.children : []
  if (!node.contentDocument?.children?.length) return children
  return children.concat(node.contentDocument.children)
}

function serializeEnhancedNode(node, lines, depth = 0, stats) {
  if (!node) return
  const children = logicalChildrenFor(node)
  const visibleChildren = children.filter(child => child.shouldDisplay || child.hasDisplayDescendant)
  if (node.nodeType === 11 && node.shadowRootType) {
    const prefix = '\t'.repeat(depth)
    const type = String(node.shadowRootType || '').toLowerCase() === 'closed' ? 'Closed' : 'Open'
    lines.push(`${prefix}${type} Shadow`)
    for (const child of visibleChildren) {
      serializeEnhancedNode(child, lines, depth + 1, stats)
    }
    if (visibleChildren.length) lines.push(`${prefix}Shadow End`)
    return
  }
  const emitLine = node.shouldDisplay
  const nextDepth = emitLine ? depth + 1 : depth
  if (emitLine) {
    const prefix = '\t'.repeat(depth)
    const shadowPrefix = node.isShadowHost ? `|SHADOW(${node.hasClosedShadowRoot ? 'closed' : 'open'})|` : ''
    let marker = ''
    if (node.tag === 'iframe' || node.tag === 'frame') {
      marker = '|IFRAME|'
    } else if (node.interactive) {
      marker = `${node.isNew ? '*' : ''}[${node.index}]`
    }
    let text = node.text ? compact(node.text, 180) : ''
    // A contenteditable host (rich-text editor) holds its current content in
    // child text nodes, not in an attribute/value, so node.text is empty and the
    // default serializer (which folds text into the element line rather than
    // emitting child text-node lines) would show it blank. Surface that inner
    // text so the model can read what is already typed.
    if (attributesSignalEditorHost(node.attributes, node.tag)) {
      const inner = snapshotTextContent(node).replace(/\s+/g, ' ').trim()
      if (inner) text = compact(inner, 180)
    }
    let line = `${prefix}${shadowPrefix}${marker}<${node.tag}${displayAttributesFor(node)}>${text}`
    const scrollText = node.capabilities?.scrollable ? scrollInfoTextFor(node) : ''
    if (scrollText) line += ` (${scrollText})`
    lines.push(line)
    stats.serializedNodeCount += 1
  }
  for (const child of visibleChildren) {
    serializeEnhancedNode(child, lines, nextDepth, stats)
  }
  if (emitLine && (node.tag === 'iframe' || node.tag === 'frame')) {
    const prefix = '\t'.repeat(depth)
    if (Array.isArray(node.hiddenElementsInfo) && node.hiddenElementsInfo.length) {
      lines.push(`${prefix}... (${node.hiddenElementsInfo.length} more elements below - scroll to reveal):`)
      for (const element of node.hiddenElementsInfo) {
        lines.push(`${prefix}    <${element.tag}> "${element.text}" ~${element.pages} pages down`)
      }
    } else if (node.hasHiddenContent) {
      lines.push(`${prefix}... (more content below viewport - scroll to reveal)`)
    }
  }
}

function browserUseTextNode(node) {
  const text = compact(node?.text || '', 180)
  if (!text) return ''
  // Keep meaningful one-character text ("A", "I", digits, CJK, etc.) while
  // continuing to suppress standalone decorative punctuation emitted by
  // pseudo-elements and icon wrappers.
  if ([...text].length === 1 && !/[\p{L}\p{N}]/u.test(text)) return ''
  return text
}

function browserUseElementShouldEmit(node) {
  if (!node || node.nodeType !== 1) return false
  if (node.isShadowHost) return true
  if (semanticHeadingLevel(node)) return true
  if (node.tag === 'svg') return true
  if (node.interactive) return true
  if (node.capabilities?.scrollable) return true
  return node.tag === 'iframe' || node.tag === 'frame'
}

function browserUseShouldShowScroll(node) {
  if (!node || node.nodeType !== 1) return false
  if (node.tag === 'iframe' || node.tag === 'frame') return true
  if (!node.capabilities?.scrollable) return false
  if (node.tag === 'html' || node.tag === 'body') return true
  return !node.parent?.capabilities?.scrollable
}

function hasBrowserUseSerializableContent(node) {
  if (!node) return false
  if (MODEL_SNAPSHOT_SKIP_SUBTREE_TAGS.has(node.tag)) return false
  if (node.nodeType === 11 && node.shadowRootType) return true
  if (node.nodeType === 3) return Boolean(browserUseTextNode(node))
  //:623 索引分配才跳过
  // ignored_by_paint_order)。excludedByParent 只让【本节点】不发射(仍递归子节点,否则顶层某容器被标记
  // 会吞掉整棵交互子树、browserUseText 变空)。ignoredByPaintOrder 不挡发射:被遮挡的 scroll/iframe/svg
  // 仍发标签行(无索引);被遮挡交互元素已在 visit(:1834)翻 interactive=false → 经 emit 判定自然不发标签行。
  if (browserUseElementShouldEmit(node) && !node.excludedByParent) return true
  return logicalChildrenFor(node).some(child => hasBrowserUseSerializableContent(child))
}

function shouldSynthesizeBrowserUseText(node) {
  if (!node || node.nodeType !== 1) return false
  const text = browserUseTextNode(node)
  if (!text) return false
  if (['input', 'select', 'textarea', 'iframe', 'frame', 'svg'].includes(node.tag)) return false
  const attrs = node.attributes || {}
  for (const name of ['aria-label', 'placeholder', 'title', 'alt', 'value', 'name', 'ax_name']) {
    if (String(attrs[name] || '').trim().toLowerCase() === text.trim().toLowerCase()) return false
  }
  return !logicalChildrenFor(node).some(child => child.nodeType === 3 && browserUseTextNode(child))
}

function serializeBrowserUseNode(node, lines, depth = 0, stats) {
  if (!node) return
  // excludedByParent 只压制【元素本身】(skip-self),仍在同一深度递归子节点
  // serialize_tree:889 excluded_by_parent → 跳本节点、原深度递归;per-node 跳过 ≠ 剪整树)。
  // ignoredByPaintOrder 不在此拦截(对齐 serialize_tree 全程不检查 ignored_by_paint_order):
  // 被遮挡 scroll/iframe/svg 流入下方正常发射门,只发无索引标签行;被遮挡交互元素已在 visit(:1834)
  // 翻 interactive=false、经 emit 判定不发标签行。用 nodeType===1 守卫:文本节点(nodeType 3)即便被标
  // excludedByParent 也照常发出文本只看 is_visible)。
  if (node.nodeType === 1 && node.excludedByParent) {
    for (const child of logicalChildrenFor(node)) {
      if (hasBrowserUseSerializableContent(child)) serializeBrowserUseNode(child, lines, depth, stats)
    }
    return
  }
  const prefix = '\t'.repeat(depth)
  if (node.nodeType === 11 && node.shadowRootType) {
    const type = String(node.shadowRootType || '').toLowerCase() === 'closed' ? 'Closed' : 'Open'
    lines.push(`${prefix}${type} Shadow`)
    for (const child of logicalChildrenFor(node)) {
      if (hasBrowserUseSerializableContent(child)) serializeBrowserUseNode(child, lines, depth + 1, stats)
    }
    if (logicalChildrenFor(node).some(child => hasBrowserUseSerializableContent(child))) lines.push(`${prefix}Shadow End`)
    return
  }

  if (node.nodeType === 3) {
    const text = browserUseTextNode(node)
    if (text) lines.push(`${prefix}${text}`)
    return
  }

  if (node.nodeType !== 1) {
    for (const child of logicalChildrenFor(node)) {
      if (hasBrowserUseSerializableContent(child)) serializeBrowserUseNode(child, lines, depth, stats)
    }
    return
  }

  const children = logicalChildrenFor(node)
  const visibleChildren = children.filter(child => hasBrowserUseSerializableContent(child))
  const emitsElement = browserUseElementShouldEmit(node)
  let nextDepth = depth

  if (emitsElement) {
    const shadowPrefix = node.isShadowHost ? `|SHADOW(${node.hasClosedShadowRoot ? 'closed' : 'open'})|` : ''
    const shouldShowScroll = browserUseShouldShowScroll(node)
    let line = `${prefix}${shadowPrefix}`
    if (node.tag === 'svg') {
      if (node.interactive) line += `${node.isNew ? '*' : ''}[${node.index}]`
      line += '<svg'
      const attributes = browserUseAttributesFor(node, '')
      if (attributes) line += ` ${attributes}`
      line += ' /> <!-- SVG content collapsed -->'
      lines.push(line)
      stats.browserUseSerializedNodeCount += 1
      return
    }
    if (shouldShowScroll && !node.interactive) {
      line += `|scroll element|<${node.tag}`
    } else if (node.interactive) {
      const scrollPrefix = shouldShowScroll ? '|scroll element[' : '['
      line += `${node.isNew ? '*' : ''}${scrollPrefix}${node.index}]<${node.tag}`
    } else if (node.tag === 'iframe') {
      line += `|IFRAME|<${node.tag}`
    } else if (node.tag === 'frame') {
      line += `|FRAME|<${node.tag}`
    } else {
      line += `<${node.tag}`
    }
    const attributes = browserUseAttributesFor(node, '')
    if (attributes) line += ` ${attributes}`
    line += ' />'
    const scrollText = shouldShowScroll ? scrollInfoTextFor(node) : ''
    if (scrollText) line += ` (${scrollText})`
    lines.push(line)
    stats.browserUseSerializedNodeCount += 1
    nextDepth += 1

    if (shouldSynthesizeBrowserUseText(node)) {
      lines.push(`${'\t'.repeat(nextDepth)}${browserUseTextNode(node)}`)
    }
  }

  for (const child of visibleChildren) {
    serializeBrowserUseNode(child, lines, nextDepth, stats)
  }

  if (emitsElement && (node.tag === 'iframe' || node.tag === 'frame')) {
    if (Array.isArray(node.hiddenElementsInfo) && node.hiddenElementsInfo.length) {
      lines.push(`${prefix}... (${node.hiddenElementsInfo.length} more elements below - scroll to reveal):`)
      for (const element of node.hiddenElementsInfo) {
        lines.push(`${prefix}    <${element.tag}> "${element.text}" ~${element.pages} pages down`)
      }
    } else if (node.hasHiddenContent) {
      lines.push(`${prefix}... (more content below viewport - scroll to reveal)`)
    }
  }
}

function serializedBackendNodeLineIndexes(root, { format = 'enhanced' } = {}) {
  const indexes = new Map()
  const documentRoots =
    root?.tag === '#documents' ? root.children || [] : root?.tag === '#document' ? [root] : [{ children: root ? [root] : [] }]
  let lineIndex = -1

  const markBackendNode = node => {
    if (node?.backendNodeId != null) indexes.set(String(node.backendNodeId), lineIndex)
  }

  const countEnhanced = node => {
    if (!node) return
    const children = logicalChildrenFor(node)
    const visibleChildren = children.filter(child => child.shouldDisplay || child.hasDisplayDescendant)
    if (node.nodeType === 11 && node.shadowRootType) {
      lineIndex += 1
      for (const child of visibleChildren) countEnhanced(child)
      if (visibleChildren.length) lineIndex += 1
      return
    }
    const emitLine = node.shouldDisplay
    if (emitLine) {
      lineIndex += 1
      markBackendNode(node)
    }
    for (const child of visibleChildren) countEnhanced(child)
    if (emitLine && (node.tag === 'iframe' || node.tag === 'frame')) {
      if (Array.isArray(node.hiddenElementsInfo) && node.hiddenElementsInfo.length) {
        lineIndex += 1 + node.hiddenElementsInfo.length
      } else if (node.hasHiddenContent) {
        lineIndex += 1
      }
    }
  }

  const countBrowserUse = node => {
    if (!node) return
    // 必须与 serializeBrowserUseNode(:901)逐行同形,否则 line-index 与实际文本行号失配,
    // iframe 缝合(runtime.cjs:3396 format:'browser_use')会插到错误行。
    // excludedByParent → skip-self + 原深度递归子节点(此前是整树 return,与序列化器不一致:凡 excluded
    // 容器内裹交互元素/iframe 即失配,一并修掉);ignoredByPaintOrder 不在此拦截 → 流入下方正常计数
    // (被遮挡 scroll/iframe/svg 仍计一行,与序列化器同步)。
    if (node.nodeType === 1 && node.excludedByParent) {
      for (const child of logicalChildrenFor(node)) {
        if (hasBrowserUseSerializableContent(child)) countBrowserUse(child)
      }
      return
    }
    if (node.nodeType === 11 && node.shadowRootType) {
      lineIndex += 1
      const serializableChildren = logicalChildrenFor(node).filter(child => hasBrowserUseSerializableContent(child))
      for (const child of serializableChildren) countBrowserUse(child)
      if (serializableChildren.length) lineIndex += 1
      return
    }
    if (node.nodeType === 3) {
      if (browserUseTextNode(node)) lineIndex += 1
      return
    }
    if (node.nodeType !== 1) {
      for (const child of logicalChildrenFor(node)) {
        if (hasBrowserUseSerializableContent(child)) countBrowserUse(child)
      }
      return
    }

    const emitsElement = browserUseElementShouldEmit(node)
    if (emitsElement) {
      lineIndex += 1
      markBackendNode(node)
      if (shouldSynthesizeBrowserUseText(node)) lineIndex += 1
    }
    for (const child of logicalChildrenFor(node)) {
      if (hasBrowserUseSerializableContent(child)) countBrowserUse(child)
    }
    if (emitsElement && (node.tag === 'iframe' || node.tag === 'frame')) {
      if (Array.isArray(node.hiddenElementsInfo) && node.hiddenElementsInfo.length) {
        lineIndex += 1 + node.hiddenElementsInfo.length
      } else if (node.hasHiddenContent) {
        lineIndex += 1
      }
    }
  }

  const isBrowserUse = String(format || '').toLowerCase() === 'browser_use'
  for (const documentRoot of documentRoots) {
    if (!isBrowserUse && (documentRoots.length > 1 || documentRoot.documentUrl)) lineIndex += 1
    for (const child of documentRoot.children || []) {
      if (isBrowserUse) {
        if (hasBrowserUseSerializableContent(child)) countBrowserUse(child)
      } else if (child.shouldDisplay || child.hasDisplayDescendant) {
        countEnhanced(child)
      }
    }
  }
  return indexes
}

function rectLeft(rect) {
  return Number(rect?.left ?? rect?.x ?? 0)
}

function rectTop(rect) {
  return Number(rect?.top ?? rect?.y ?? 0)
}

function rectRight(rect) {
  return Number(rect?.right ?? rectLeft(rect) + Number(rect?.width || 0))
}

function rectBottom(rect) {
  return Number(rect?.bottom ?? rectTop(rect) + Number(rect?.height || 0))
}

function containmentRatio(child, parent) {
  if (!child || !parent) return 0
  const xOverlap = Math.max(0, Math.min(rectRight(child), rectRight(parent)) - Math.max(rectLeft(child), rectLeft(parent)))
  const yOverlap = Math.max(0, Math.min(rectBottom(child), rectBottom(parent)) - Math.max(rectTop(child), rectTop(parent)))
  const childArea = Math.max(0, Number(child.width || 0)) * Math.max(0, Number(child.height || 0))
  if (!childArea) return 0
  return (xOverlap * yOverlap) / childArea
}

function shouldExcludeByPropagatingBounds(node, activeBounds, threshold) {
  if (!node || !activeBounds?.rect || !node.rect) return false
  if (node.nodeType !== 1) return false
  if (containmentRatio(node.rect, activeBounds.rect) < threshold) return false
  if (FORM_ELEMENT_TAGS.has(node.tag)) return false
  if (isPropagatingElement(node)) return false
  if (node.attributes?.onclick != null) return false
  if (String(node.attributes?.['aria-label'] || '').trim()) return false
  if (INDEPENDENT_INTERACTIVE_ROLES.has(String(node.role || node.attributes?.role || '').toLowerCase())) return false
  return true
}

function applyContainmentPruning(node, activeBounds = null, stats, threshold = 0.99) {
  if (!node) return
  if (shouldExcludeByPropagatingBounds(node, activeBounds, threshold)) {
    node.excludedByParent = true
    stats.excludedByParentCount += 1
  }
  const nextBounds = isPropagatingElement(node) && node.rect ? { rect: node.rect, tag: node.tag, backendNodeId: node.backendNodeId } : activeBounds
  for (const child of node.children || []) applyContainmentPruning(child, nextBounds, stats, threshold)
}

function enrichCompoundComponents(node, stats) {
  if (!node) return
  for (const child of node.children || []) enrichCompoundComponents(child, stats)
  if (node.tag === 'select') {
    // Publish one canonical human-visible current value everywhere. Explicit
    // optionSelected state outranks AX, AX outranks the default first option,
    // and a static HTML value attribute is only a last-resort fallback.
    const currentValue = selectedOptionTextFrom(node)
    if (currentValue) {
      node.value = currentValue
      node.attributes.value = currentValue
    }
    const semanticLabel = compact(
      node.attributes.ax_name ||
      node.attributes['aria-label'] ||
      node.attributes.name ||
      node.attributes.title ||
      '',
      180
    )
    if (semanticLabel) node.text = semanticLabel
  }
  node.compoundComponents = compoundComponentsFor(node)
  if (node.compoundComponents.length) {
    node.isCompoundComponent = true
    stats.compoundComponentCount += 1
  }
}

function rectIntersects(a, b) {
  return !(rectRight(a) <= rectLeft(b) || rectRight(b) <= rectLeft(a) || rectBottom(a) <= rectTop(b) || rectBottom(b) <= rectTop(a))
}

function rectContains(a, b) {
  return rectLeft(a) <= rectLeft(b) && rectTop(a) <= rectTop(b) && rectRight(a) >= rectRight(b) && rectBottom(a) >= rectBottom(b)
}

function splitRectDifference(a, b) {
  const pieces = []
  const ax1 = rectLeft(a)
  const ay1 = rectTop(a)
  const ax2 = rectRight(a)
  const ay2 = rectBottom(a)
  const bx1 = rectLeft(b)
  const by1 = rectTop(b)
  const bx2 = rectRight(b)
  const by2 = rectBottom(b)
  const yLo = Math.max(ay1, by1)
  const yHi = Math.min(ay2, by2)
  if (ay1 < by1) pieces.push({ left: ax1, top: ay1, width: ax2 - ax1, height: by1 - ay1 })
  if (by2 < ay2) pieces.push({ left: ax1, top: by2, width: ax2 - ax1, height: ay2 - by2 })
  if (ax1 < bx1 && yLo < yHi) pieces.push({ left: ax1, top: yLo, width: bx1 - ax1, height: yHi - yLo })
  if (bx2 < ax2 && yLo < yHi) pieces.push({ left: bx2, top: yLo, width: ax2 - bx2, height: yHi - yLo })
  return pieces.filter(piece => piece.width > 0 && piece.height > 0)
}

class RectUnion {
  constructor(maxRects = 5000) {
    this.maxRects = maxRects
    this.rects = []
  }

  contains(rect, includeOwner = null) {
    if (!this.rects.length) return false
    let stack = [rect]
    for (const existing of this.rects) {
      if (includeOwner && !includeOwner(existing.owner || null)) continue
      const next = []
      for (const piece of stack) {
        if (rectContains(existing, piece)) continue
        if (rectIntersects(piece, existing)) next.push(...splitRectDifference(piece, existing))
        else next.push(piece)
      }
      if (!next.length) return true
      stack = next
    }
    return false
  }

  add(rect, owner = null) {
    if (this.rects.length >= this.maxRects) return false
    if (this.contains(rect)) return false
    let pending = [rect]
    for (const existing of this.rects) {
      const next = []
      for (const piece of pending) {
        if (rectIntersects(piece, existing)) next.push(...splitRectDifference(piece, existing))
        else next.push(piece)
      }
      pending = next
      if (!pending.length) break
    }
    this.rects.push(...pending.map(piece => ({ ...piece, owner })))
    return Boolean(pending.length)
  }
}

function isStrictDescendantOf(node, ancestor) {
  let cursor = node?.parent || null
  while (cursor) {
    if (cursor === ancestor) return true
    cursor = cursor.parent || null
  }
  return false
}

function effectiveOpacityForPaint(node) {
  let opacity = 1
  let cursor = node
  while (cursor) {
    const raw = cursor.computedStyles?.opacity
    if (raw != null && raw !== '') {
      const value = Number(raw)
      if (Number.isFinite(value)) opacity *= Math.max(0, Math.min(1, value))
    }
    if (opacity < 0.8) return opacity
    cursor = cursor.parent || null
  }
  return opacity
}

function shouldAddToPaintUnion(node) {
  const styles = node?.computedStyles || {}
  // CSS opacity is composited through the ancestor chain. A child reporting
  // opacity:1 is still invisible inside an opacity:0 flyout and therefore
  // cannot visually cover a real control underneath it.
  if (effectiveOpacityForPaint(node) < 0.8) return false
  const background = String(styles['background-color'] || '').trim().toLowerCase()
  if (background === 'rgba(0, 0, 0, 0)' || background === 'transparent') return false
  return true
}

function applyPaintOrderFiltering(rootNodes = [], stats) {
  const nodes = []
  const collect = node => {
    if (!node) return
    // Fan's cursor / operating frame / action highlights are cosmetic UI
    // injected into the inspected page.  They are pruned later by `visit`, but
    // paint-order filtering runs before that pruning.  Letting an opaque child
    // of one of these overlays enter the union can therefore mark the real page
    // element underneath as occluded and remove its ref from the snapshot even
    // though the overlay has pointer-events:none.  Skip the whole subtree at
    // the first geometry stage, not only at serialization time.
    if (node.nodeType === 1 && isFanOverlayNode(node)) return
    if (node.rect && node.paintOrder != null) nodes.push(node)
    for (const child of node.children || []) collect(child)
  }
  for (const root of rootNodes) collect(root)
  const groups = new Map()
  for (const node of nodes) {
    const order = Number(node.paintOrder)
    if (!Number.isFinite(order)) continue
    if (!groups.has(order)) groups.set(order, [])
    groups.get(order).push(node)
  }
  const union = new RectUnion()
  for (const order of Array.from(groups.keys()).sort((a, b) => b - a)) {
    const addLater = []
    for (const node of groups.get(order) || []) {
      // A control's label/icon normally paints above the control itself.
      // Those descendants are part of the same hit target and must never make
      // their own button/host look externally occluded (UPS <ups-cta> is a
      // real-world example). Only coverage owned outside this subtree can hide
      // the target. RectUnion keeps provenance so genuine sibling overlays
      // continue to suppress the controls underneath them.
      if (union.contains(node.rect, owner => !isStrictDescendantOf(owner, node))) {
        node.ignoredByPaintOrder = true
        stats.ignoredByPaintOrderCount += 1
      }
      if (shouldAddToPaintUnion(node)) addLater.push({ rect: node.rect, owner: node })
    }
    for (const { rect, owner } of addLater) union.add(rect, owner)
  }
}

function hasInteractiveDescendants(node) {
  for (const child of logicalChildrenFor(node)) {
    if (child.interactive) return true
    if (hasInteractiveDescendants(child)) return true
  }
  return false
}

function isDropdownLikeContainer(node) {
  const role = String(node?.role || node?.attributes?.role || '').toLowerCase()
  const tag = String(node?.tag || '').toLowerCase()
  const classList = String(node?.attributes?.class || '').toLowerCase().split(/\s+/).filter(Boolean)
  const className = classList.join(' ')
  return (
    ['listbox', 'menu', 'combobox', 'menubar', 'tree', 'grid'].includes(role) ||
    tag === 'select' ||
    classList.includes('dropdown') ||
    classList.includes('dropdown-menu') ||
    classList.includes('select-menu') ||
    (classList.includes('ui') && className.includes('dropdown'))
  )
}

// 我方注入的覆盖层标记:接管光标(__fan_cursor)、操作光框(__fan_operating_frame)、高亮框
// (__fan_browser_runtime_highlights)、光束/呼吸等。这些不是页面内容,必须整棵子树排除在观测之外,
// 否则视觉模型会把发光的光标 svg 当成发送箭头去点(真机 bug;无此类覆盖层故无此问题)。
function isFanOverlayNode(node) {
  const a = (node && node.attributes) || {}
  const id = String(a.id || '')
  if (id.indexOf('__fan_') === 0) return true
  const cls = String(a.class || a.className || '')
  return cls.indexOf('__fan_') !== -1
}

function applyInteractiveDetection(rootNodes = []) {
  const visit = node => {
    if (!node) return
    // 命中我方覆盖层根 → 整棵子树跳过(不递归子节点),其内的 svg/div 都不会被发号/画框/点击。
    if (node.nodeType === 1 && isFanOverlayNode(node)) return
    for (const child of node.children || []) visit(child)
    if (node.nodeType === 1) {
      const signal = isInteractiveNode({
        attributes: node.attributes || {},
        layoutInfo: { bounds: node.rect, computedStyles: node.computedStyles || {} },
        tag: node.tag,
        node
      })
      // 对齐 serializer.py:704 —— 发号判据是 is_interactive AND is_visible,
      // 且 is_visible 含【硬几何门】(service.py:275 `if not bounds: return False`):0 几何元素
      // 【不】凭 JS 监听器/onclick/cursor 越几何门拿索引。此前的 zeroSizeOverlay 旁路正是这么干的,
      // 会把文心一言那种 display:contents 空 <button>(无 contentQuads/box)也索引成"可点发送键",
      // 而真正可点、有几何的 <div>(36×36+class)由图标规则(:299-309,等价 clickable_elements.py:228-240)
      // 正常命中——于是"被索引但无几何 vs 有几何但被错过"同时发生,是错号根因。改回与 一致:
      // 强交互信号只决定 signal,决定不了越过几何门;无几何即不发号。仅有的两个几何门例外是
      // file input(opacity:0 自定义文件选择器,serializer.py:654-659)与 shadow 表单控件(:664-670)。
      const attrs = node.attributes || {}
      const isFileInput = node.tag === 'input' && attrs.type === 'file'
      const baseInteractive = signal && (Boolean(node.visible) || isFileInput)
      const scrollable = Boolean(node.visible && node.capabilities?.scrollable)
      if (scrollable && !baseInteractive) {
        node.interactive = isDropdownLikeContainer(node) || !hasInteractiveDescendants(node)
      } else {
        node.interactive = baseInteractive
      }
    }
  }
  for (const root of rootNodes) visit(root)
}

function contentDocumentIndexFor(nodes, nodeIndex) {
  const raw = parseRareValue(nodes.contentDocumentIndex, nodeIndex)
  const numeric = Number(raw)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null
}

function shadowRootTypeFor(strings, nodes, nodeIndex) {
  const parsed = parseRareString(strings, nodes.shadowRootType, nodeIndex)
  if (parsed) return parsed
  const raw = parseRareValue(nodes.shadowRootType, nodeIndex)
  return typeof raw === 'string' ? raw : ''
}

function linkContentDocuments(builtDocuments = []) {
  const ownedDocumentIndexes = new Set()
  const byIndex = new Map(builtDocuments.map(document => [document.index, document]))
  for (const documentInfo of builtDocuments) {
    for (const node of documentInfo.nodes || []) {
      if (!node || (node.tag !== 'iframe' && node.tag !== 'frame')) continue
      const contentDocumentIndex = Number(node.contentDocumentIndex)
      if (!Number.isInteger(contentDocumentIndex)) continue
      const contentDocument = byIndex.get(contentDocumentIndex)
      if (!contentDocument?.root || contentDocument === documentInfo) continue
      node.contentDocument = contentDocument.root
      ownedDocumentIndexes.add(contentDocumentIndex)
    }
  }
  return ownedDocumentIndexes
}

function isHiddenByIframeViewport(node, viewportHeight, scrollOffsetY = 0) {
  if (!node || node.nodeType !== 1 || !node.rect || viewportHeight <= 0) return false
  if (isCssHiddenNode(node)) return false
  // DOMSnapshot layout bounds are document coordinates and deliberately do
  // not include the DocumentSnapshot scroll offset. Compare in viewport
  // coordinates so a control scrolled into view inside a same-origin iframe
  // can receive a fresh model-visible number.
  const viewportTop = rectTop(node.rect) - scrollOffsetY
  const viewportBottom = rectBottom(node.rect) - scrollOffsetY
  return viewportTop >= viewportHeight || viewportBottom <= 0
}

function hiddenElementLabel(node) {
  const attrs = node?.attributes || {}
  return compact(node?.text || attrs.placeholder || attrs.title || attrs['aria-label'] || attrs.name || '', 40) || '(no label)'
}

function collectIframeHiddenInfo(
  root,
  viewportHeight,
  scrollOffsetY = 0,
  hidden = [],
  state = { hasHiddenContent: false }
) {
  if (!root || hidden.length >= 50) return { hidden, hasHiddenContent: state.hasHiddenContent }
  if (root.nodeType === 1 && isHiddenByIframeViewport(root, viewportHeight, scrollOffsetY)) {
    state.hasHiddenContent = true
    const interactive = isInteractiveNode({
      attributes: root.attributes || {},
      layoutInfo: { bounds: root.rect, computedStyles: root.computedStyles || {} },
      tag: root.tag,
      node: root
    })
    if (interactive) {
      hidden.push({
        tag: root.tag || '?',
        text: hiddenElementLabel(root),
        pages: viewportHeight > 0
          ? Math.round(((rectTop(root.rect) - scrollOffsetY) / viewportHeight) * 10) / 10
          : 0
      })
    }
  }
  // A nested iframe owns a separate document coordinate space and scroll
  // offset. Count its owner element here; its content is handled by that
  // iframe's own markIframeContentVisibility pass.
  for (const child of root.children || []) {
    collectIframeHiddenInfo(child, viewportHeight, scrollOffsetY, hidden, state)
  }
  return { hidden, hasHiddenContent: state.hasHiddenContent }
}

function markIframeContentVisibility(root) {
  if (!root) return
  if ((root.tag === 'iframe' || root.tag === 'frame') && root.contentDocument) {
    const viewportHeight = Number(root.rect?.height || 0)
    const scrollOffsetY = Number(root.contentDocument.scrollOffsetY || 0)
    const frameVisible = root.visible !== false
    const state = { hasHiddenContent: false }
    const hidden = []
    for (const child of root.contentDocument.children || []) {
      collectIframeHiddenInfo(child, viewportHeight, scrollOffsetY, hidden, state)
    }
    hidden.sort((left, right) => left.pages - right.pages)
    root.hiddenElementsInfo = hidden.slice(0, 10)
    root.hasHiddenContent = root.hiddenElementsInfo.length === 0 && state.hasHiddenContent

    const mark = node => {
      if (!node) return
      if (!frameVisible || isHiddenByIframeViewport(node, viewportHeight, scrollOffsetY)) {
        node.visible = false
      }
      for (const child of node.children || []) mark(child)
    }
    for (const child of root.contentDocument.children || []) mark(child)
  }
  for (const child of logicalChildrenFor(root)) markIframeContentVisibility(child)
}

function markShadowHosts(rootNodes = []) {
  const visit = node => {
    if (!node) return false
    let hasShadowRootChild = false
    let hasClosedShadowRoot = false
    for (const child of node.children || []) {
      // CDP has two shapes in practice:
      // 1. DOM.getDocument exposes a nodeType=11 document fragment.
      // 2. DOMSnapshot flattens the shadow root into its first element and
      //    stores shadowRootType on that nodeType=1 child.
      // Recognise both so the host identity is retained in the serialized
      // model view instead of presenting controls from different components
      // as unrelated flat rows.
      if (child.shadowRootType) {
        hasShadowRootChild = true
        if (String(child.shadowRootType).toLowerCase() === 'closed') hasClosedShadowRoot = true
      }
      visit(child)
    }
    node.isShadowHost = Boolean(node.nodeType === 1 && hasShadowRootChild)
    node.hasClosedShadowRoot = Boolean(node.isShadowHost && hasClosedShadowRoot)
    return Boolean(node.nodeType === 11 && node.shadowRootType)
  }
  for (const root of rootNodes) visit(root)
}

function nearestShadowHost(node) {
  let cursor = node?.parent || null
  while (cursor) {
    if (cursor.shadowRootType && cursor.parent?.isShadowHost) return cursor.parent
    cursor = cursor.parent || null
  }
  return null
}

function compactShadowHostEvidence(node) {
  const host = nearestShadowHost(node)
  if (!host) return null
  const evidence = {
    tag: host.tag,
    backendNodeId: host.backendNodeId
  }
  const attributes = host.attributes || {}
  if (attributes.id) evidence.id = compact(attributes.id, 100)
  if (attributes.name) evidence.name = compact(attributes.name, 100)
  if (attributes['aria-label']) evidence.ariaLabel = compact(attributes['aria-label'], 100)
  return evidence
}

function attributesFromDomNode(raw = []) {
  const attributes = {}
  if (!Array.isArray(raw)) return attributes
  for (let index = 0; index < raw.length - 1; index += 2) {
    const name = String(raw[index] || '')
    if (!name) continue
    attributes[name] = String(raw[index + 1] ?? '')
  }
  return attributes
}

function domDocumentNodeText(
  node = {},
  attributes = {},
  accessibility = null,
  sensitiveValues = new Set()
) {
  const tag = String(node.localName || node.nodeName || '').toLowerCase()
  const passwordInput = isPasswordInput(tag, attributes)
  const safeAttributes = scrubSensitiveControlAttributes(tag, { ...attributes }, undefined, sensitiveValues)
  const accessibilityName = passwordInput
    ? redactPasswordString(accessibility?.name, sensitiveValues)
    : accessibility?.name
  const nodeValue = passwordInput
    ? redactPasswordString(node.nodeValue, sensitiveValues)
    : node.nodeValue
  return compact(
    safeAttributes['aria-label'] ||
      safeAttributes.placeholder ||
      safeAttributes.title ||
      safeAttributes.alt ||
      safeAttributes.name ||
      accessibilityName ||
      safeAttributes.value ||
      nodeValue ||
      ''
  )
}

function domDocumentStats(root = null) {
  const stats = {
    nodeCount: 0,
    elementCount: 0,
    shadowRootCount: 0,
    contentDocumentCount: 0
  }
  const visit = node => {
    if (!node) return
    stats.nodeCount += 1
    if (node.nodeType === 1) stats.elementCount += 1
    for (const child of node.children || []) visit(child)
    for (const shadowRoot of node.shadowRoots || []) {
      stats.shadowRootCount += 1
      visit(shadowRoot)
    }
    if (node.contentDocument) {
      stats.contentDocumentCount += 1
      visit(node.contentDocument)
    }
  }
  visit(root)
  return stats
}

function buildDomDocumentElements(
  domDocument,
  {
    startIndex = 1,
    maxElements = 300,
    accessibility = null,
    jsClickListenerBackendIds = null,
    previousState = null,
    excludeBackendNodeIds = null,
    source = 'dom-document'
  } = {}
) {
  const root = domDocument?.root || domDocument
  const elements = []
  const previousBackendIds = new Set(previousState?.backendNodeIds || [])
  // backendNodeIds the layout snapshot already SAW (included or deliberately
  // dropped as hidden/occluded). We must NOT re-add those here — this supplement
  // only fills in elements the snapshot never covered (no-layout shadow/etc.).
  const excludeIds = excludeBackendNodeIds instanceof Set ? excludeBackendNodeIds : new Set(excludeBackendNodeIds || [])
  const accessibilityByBackendNodeId = accessibility?.byBackendNodeId || new Map()
  const jsListenerIds = jsClickListenerBackendIds instanceof Set ? jsClickListenerBackendIds : new Set(jsClickListenerBackendIds || [])
  let nextIndex = Number(startIndex) || 1

  const visit = (node, context = {}) => {
    if (!node || elements.length >= maxElements) return
    const tag = String(node.localName || node.nodeName || '').toLowerCase()
    const backendNodeId = node.backendNodeId || null
    const attributes = attributesFromDomNode(node.attributes)
    const accessibilityNode =
      backendNodeId != null && accessibilityByBackendNodeId?.get
        ? accessibilityByBackendNodeId.get(Number(backendNodeId)) || null
        : null
    if (accessibilityNode) {
      for (const [name, value] of Object.entries(accessibilityNode.attributes || {})) {
        if (attributes[name] == null) attributes[name] = value
      }
      if (accessibilityNode.role && !attributes.role) attributes.role = accessibilityNode.role
      if (accessibilityNode.name && !attributes.ax_name) attributes.ax_name = accessibilityNode.name
    }
    const passwordInput = isPasswordInput(tag, attributes)
    const sensitiveValues = passwordInput
      ? collectPasswordSensitiveValues(attributes, accessibilityNode?.value)
      : new Set()
    const passwordPopulated = passwordInput &&
      accessibilityNode &&
      Object.hasOwn(accessibilityNode, 'value')
      ? Boolean(accessibilityNode.value)
      : undefined
    scrubSensitiveControlAttributes(tag, attributes, passwordPopulated, sensitiveValues)
    const accessibilityName = passwordInput
      ? redactPasswordString(accessibilityNode?.name, sensitiveValues)
      : accessibilityNode?.name
    const hasJsClickListener = backendNodeId != null && jsListenerIds.has(Number(backendNodeId))
    const structuredFields = structuredElementFieldsFor(tag, attributes, {
      accessibilityName: accessibilityName || '',
      liveValue: passwordInput
        ? attributes.value
        : (accessibilityNode?.value || undefined)
    })
    const { type } = structuredFields
    // dom-document 路是【几何盲】的(给 isInteractiveNode 传 layoutInfo:{}),它只能作为 enhanced
    // (几何路)的补充。仅有两个法定例外——file input
    // (opacity:0 自定义文件选择器,serializer.py:654-659)与 shadow DOM 表单控件(serializer.py:664-670)。
    // 【删除】此前凭 hasJsClickListener / native-tag / role / AX 在几何盲下广收的逻辑——它会把 enhanced
    // 已按几何门正确淘汰的无几何元素(文心一言 display:contents 空 <button>)在这里重新发号(实测:
    // edit#1 后空 button 从 source:dom-document 复活)。有几何的可点元素一律由 enhanced 路命中,不靠这里。
    const isShadowFormEl =
      Boolean(context?.inShadowTree) && (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'a')
    const interactive =
      node.nodeType === 1 &&
      backendNodeId != null &&
      !excludeIds.has(Number(backendNodeId)) &&
      (type === 'file' || isShadowFormEl)
    const hiddenInput = tag === 'input' && type === 'hidden'
    if (interactive && !hiddenInput) {
      elements.push({
        index: nextIndex,
        tag,
        role: String(attributes.role || accessibilityNode?.role || ''),
        ...structuredFields,
        text: domDocumentNodeText(
          node,
          attributes,
          accessibilityNode ? { ...accessibilityNode, name: accessibilityName } : null,
          sensitiveValues
        ),
        selector: '',
        framePath: [],
        path: [],
        source,
        backendNodeId,
        nodeId: node.nodeId || null,
        frameId: node.frameId || context.frameId || '',
        documentUrl: context.documentUrl || '',
        paintOrder: null,
        attributes,
        capabilities: {
          clickable: true,
          typeable: tag === 'textarea' || ['textbox', 'searchbox'].includes(String(attributes.role || '').toLowerCase()) ||
            (tag === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)),
          selectable: tag === 'select',
          upload: tag === 'input' && type === 'file',
          scrollable: false
        },
        disabled: attributesSignalDisabled(attributes),
        readonly: attributesSignalReadOnly(attributes),
        scroll: null,
        scrollInfo: null,
        rect: null,
        hasJsClickListener,
        isNew: backendNodeId ? !previousBackendIds.has(Number(backendNodeId)) : false
      })
      nextIndex += 1
    }

    const childContext = {
      ...context,
      frameId: node.frameId || context.frameId || '',
      documentUrl: node.documentURL || context.documentUrl || ''
    }
    for (const child of node.children || []) visit(child, childContext)
    for (const shadowRoot of node.shadowRoots || []) {
      visit(shadowRoot, { ...childContext, inShadowTree: true })
    }
    if (node.contentDocument) {
      visit(node.contentDocument, { ...childContext, inContentDocument: true, documentUrl: node.contentDocument.documentURL || childContext.documentUrl })
    }
  }

  visit(root, {})
  return {
    elements,
    stats: {
      ...domDocumentStats(root),
      elementCount: elements.length,
      jsClickListenerCount: elements.filter(element => element.hasJsClickListener).length
    }
  }
}

function buildEnhancedSnapshotState(
  snapshot,
  { maxElements = 300, previousState = null, accessibility = null, jsClickListenerBackendIds = null, devicePixelRatio = 1 } = {}
) {
  const strings = snapshot?.strings || []
  const documents = snapshot?.documents || []
  const previousBackendIds = new Set(previousState?.backendNodeIds || [])
  const accessibilityByBackendNodeId = accessibility?.byBackendNodeId || new Map()
  const jsListenerIds = jsClickListenerBackendIds instanceof Set ? jsClickListenerBackendIds : new Set(jsClickListenerBackendIds || [])
  const elements = []
  const roots = []
  const stats = {
    documentCount: documents.length,
    nodeCount: 0,
    elementCount: 0,
    interactiveCount: 0,
    serializedNodeCount: 0,
    browserUseSerializedNodeCount: 0,
    compoundComponentCount: 0,
    excludedByParentCount: 0,
    ignoredByPaintOrderCount: 0,
    hiddenIframeElementCount: 0,
    truncatedInteractiveCount: 0,
    // <page_stats> 计数(口径):在下面的 visit 单次遍历里就地累加,经 1855 return →
    // runtime.cjs 3275 snapshotStats → 3441 value.snapshot 一路回传,observe 收尾据此拼 <page_stats>。
    // totalElements=每访问一个(非覆盖层)节点 +1(含元素/文本/文档/shadow 根);textChars=文本节点 strip 后字符数;
    // links/iframeCount/imageCount 按 tag 归类;shadowOpen/Closed 按 shadow 宿主计一次(open/closed 由 markShadowHosts 预标)。
    totalElements: 0,
    textChars: 0,
    linkCount: 0,
    iframeCount: 0,
    imageCount: 0,
    shadowOpenCount: 0,
    shadowClosedCount: 0,
    noLayoutFileInputCount: 0
  }
  stats.jsClickListenerCount = jsListenerIds.size
  let nextIndex = 1
  const builtDocuments = []
  // Every element backendNodeId the layout-based snapshot SAW (whether or not it
  // ended up included). The DOM.getDocument supplement uses this to only add
  // elements the snapshot never covered (no-layout shadow/etc.), instead of
  // re-adding ones the snapshot deliberately dropped as hidden/occluded.
  const seenBackendNodeIds = new Set()

  for (const [documentIndex, document] of documents.entries()) {
    const nodes = document.nodes || {}
    const layoutLookup = buildLayoutLookup(document, strings, OBSERVE_COMPUTED_STYLES, devicePixelRatio)
    const parentIndexes = parentIndexesFor(nodes)
    const nodeNames = nodes.nodeName || []
    const nodeTypes = nodes.nodeType || []
    const backendNodeIds = nodes.backendNodeId || []
    const rawAttributes = nodes.attributes || []
    const currentUrl = readString(strings, document.documentURL)
    const frameId = readString(strings, document.frameId)
    const built = []

    for (let nodeIndex = 0; nodeIndex < nodeNames.length; nodeIndex += 1) {
      const nodeType = nodeTypes[nodeIndex]
      const rawTag = readString(strings, nodeNames[nodeIndex])
      const tag = nodeType === 1 ? rawTag.toLowerCase() : rawTag.toLowerCase() || nodeTypeName(nodeType)
      const attributes = parseAttributes(strings, rawAttributes[nodeIndex])
      applyLiveFormState(nodes, nodeIndex, tag, attributes)
      const layoutInfo = layoutLookup.get(nodeIndex)
      const rect = layoutInfo?.bounds || null
      const visible = nodeType === 1 && Boolean(rect) && !isHiddenByStyle(layoutInfo)
      const type = String(attributes.type || '').toLowerCase()
      // 把输入控件【当前已输入值】(DOMSnapshot inputValue,DOM 实时 value)注入 value 属性,使
      // browser_use/enhanced 行显示 value="…"。textarea 没有 value 属性、shouldSynthesizeBrowserUseText
      // 对它又返回 false,不注入就完全看不到用户输入了什么(最初"假输入"困惑的根)。
      // Passwords retain only a fixed populated marker.
      const liveInputValue = tag === 'textarea' || tag === 'input'
        ? compact(parseRareString(strings, nodes.inputValue, nodeIndex) || '', 500)
        : ''
      const hasCapturedLiveInputValue = (tag === 'textarea' || tag === 'input') &&
        hasRareValue(nodes.inputValue, nodeIndex)
      if (liveInputValue && type !== 'password') {
        attributes.value = liveInputValue
      }
      const backendNodeId = backendNodeIds[nodeIndex] || null
      const hasJsClickListener = backendNodeId != null && jsListenerIds.has(Number(backendNodeId))
      const accessibilityNode =
        backendNodeId != null && accessibilityByBackendNodeId?.get
          ? accessibilityByBackendNodeId.get(Number(backendNodeId)) || null
          : null
      if (accessibilityNode) {
        for (const [name, value] of Object.entries(accessibilityNode.attributes || {})) {
          if (attributes[name] == null) attributes[name] = value
        }
        if (accessibilityNode.role && !attributes.role) attributes.role = accessibilityNode.role
        if (accessibilityNode.name && !attributes.ax_name) attributes.ax_name = accessibilityNode.name
        // 表单控件的当前值:DOMSnapshot inputValue/optionSelected 抓不到时,
        // 用 AX value 兜底。原生 select 在 Chromium 不提供 option 子树时
        // 仍必须把当前选项交给最终快照验证。
        if (accessibilityNode.value && tag === 'select') {
          // A select's HTML `value` content attribute is not authoritative
          // current state. AX is live browser state, so it must replace a
          // stale/static attribute before selected-option reconciliation.
          attributes.value = compact(accessibilityNode.value, 500)
        } else if (
          accessibilityNode.value &&
          (tag === 'textarea' || tag === 'input') &&
          !attributes.value
        ) {
          attributes.value = compact(accessibilityNode.value, 500)
        }
      }
      const passwordInput = isPasswordInput(tag, attributes)
      const sensitiveValues = passwordInput
        ? collectPasswordSensitiveValues(attributes, liveInputValue, accessibilityNode?.value)
        : new Set()
      const passwordPopulated = passwordInput
        ? (hasCapturedLiveInputValue
            ? Boolean(liveInputValue)
            : (accessibilityNode && Object.hasOwn(accessibilityNode, 'value')
                ? Boolean(accessibilityNode.value)
                : undefined))
        : undefined
      scrubSensitiveControlAttributes(tag, attributes, passwordPopulated, sensitiveValues)
      const accessibilityName = passwordInput
        ? redactPasswordString(accessibilityNode?.name, sensitiveValues)
        : accessibilityNode?.name
      const structuredFields = structuredElementFieldsFor(tag, attributes, {
        accessibilityName: accessibilityName || ''
      })
      const node = {
        nodeIndex,
        nodeType,
        nodeTypeName: nodeTypeName(nodeType),
        tag,
        role: String(attributes.role || ''),
        ...structuredFields,
        liveValue: tag === 'select'
          ? compact(accessibilityNode?.value || '', 500)
          : structuredFields.value,
        text: nodeText(
          strings,
          nodes,
          nodeIndex,
          tag,
          attributes,
          layoutInfo,
          accessibilityNode ? { ...accessibilityNode, name: accessibilityName } : null,
          sensitiveValues
        ),
        // SHC-3/C4b:文本节点保留未折叠的原始 nodeValue,供 <pre> 内容提取保留内部换行(text 已 compact 折叠空白)
        rawText: nodeType === 3 ? String(parseRareString(strings, nodes.nodeValue, nodeIndex) || '') : '',
        attributes,
        rect,
        visible,
        interactive: false,
        disabled: attributesSignalDisabled(attributes),
        readonly: attributesSignalReadOnly(attributes),
        capabilities: nodeType === 1 ? capabilitiesFor(tag, attributes, layoutInfo) : {},
        scrollInfo: nodeType === 1 ? scrollInfoFor(layoutInfo) : null,
        computedStyles: layoutInfo?.computedStyles || {},
        backendNodeId,
        frameId,
        documentUrl: currentUrl,
        paintOrder: layoutInfo?.paintOrder ?? null,
        children: [],
        parent: null,
        index: null,
        source: 'enhanced-snapshot',
        shouldDisplay: false,
        hasDisplayDescendant: false,
        isNew: false,
        excludedByParent: false,
        ignoredByPaintOrder: false,
        compoundComponents: [],
        isCompoundComponent: false,
        contentDocumentIndex: contentDocumentIndexFor(nodes, nodeIndex),
        contentDocument: null,
        hiddenElementsInfo: [],
        hasHiddenContent: false,
        shadowRootType: shadowRootTypeFor(strings, nodes, nodeIndex),
        isShadowHost: false,
        hasClosedShadowRoot: false
      }
      node.hasJsClickListener = hasJsClickListener
      built[nodeIndex] = node
      stats.nodeCount += 1
      // 只有【有 layout(rect)】的节点才记入 seenBackendNodeIds:这些是快照真正几何处理过的
      // (入选 或 被当 hidden/occluded 丢弃),补充层不该再加。无 layout 的节点(典型:shadow 内
      // 无渲染框的表单控件)不记入 → DOM.getDocument 补充层能把它们加回(否则被冻结永久丢失)。
      if (nodeType === 1 && backendNodeId != null && node.rect) seenBackendNodeIds.add(Number(backendNodeId))
    }

    for (let nodeIndex = 0; nodeIndex < built.length; nodeIndex += 1) {
      const node = built[nodeIndex]
      if (!node) continue
      const parentIndex = parentIndexes[nodeIndex]
      const parent = Number.isInteger(parentIndex) && parentIndex >= 0 ? built[parentIndex] : null
      if (parent) {
        node.parent = parent
        parent.children.push(node)
      }
    }

    const documentRoots = built.filter((node, index) => {
      const parentIndex = parentIndexes[index]
      return !Number.isInteger(parentIndex) || parentIndex < 0 || !built[parentIndex]
    })
    const root = {
      tag: '#document',
      nodeType: 9,
      documentUrl: currentUrl,
      frameId,
      // Keep document scroll in the same CSS-pixel coordinate system as the
      // normalized layout bounds consumed by iframe visibility checks.
      scrollOffsetX: Number(document.scrollOffsetX || 0) / (Number(devicePixelRatio) > 0 ? Number(devicePixelRatio) : 1),
      scrollOffsetY: Number(document.scrollOffsetY || 0) / (Number(devicePixelRatio) > 0 ? Number(devicePixelRatio) : 1),
      children: documentRoots,
      shouldDisplay: false,
      hasDisplayDescendant: false
    }
    roots.push(root)
    builtDocuments.push({ index: documentIndex, root, documentRoots, nodes: built })
  }

  const ownedDocumentIndexes = linkContentDocuments(builtDocuments)
  const topDocuments = builtDocuments.filter(document => !ownedDocumentIndexes.has(document.index))
  const traversalRoots = topDocuments.length ? topDocuments.flatMap(document => document.documentRoots) : builtDocuments.flatMap(document => document.documentRoots)

  for (const documentInfo of builtDocuments) markShadowHosts(documentInfo.documentRoots)
  for (const rootNode of traversalRoots) markIframeContentVisibility(rootNode)
  stats.hiddenIframeElementCount = traversalRoots.reduce((total, rootNode) => {
    let count = 0
    const collect = node => {
      if (!node) return
      count += Array.isArray(node.hiddenElementsInfo) ? node.hiddenElementsInfo.length : 0
      for (const child of logicalChildrenFor(node)) collect(child)
    }
    collect(rootNode)
    return total + count
  }, 0)

  for (const documentInfo of builtDocuments) {
    applyInteractiveDetection(documentInfo.documentRoots)
    for (const rootNode of documentInfo.documentRoots) enrichCompoundComponents(rootNode, stats)
    applyPaintOrderFiltering(documentInfo.documentRoots, stats)
    for (const rootNode of documentInfo.documentRoots) applyContainmentPruning(rootNode, null, stats)
  }

  const visit = node => {
    if (!node) return false
    // 我方注入的覆盖层(__fan_cursor 接管光标 / __fan_operating_frame / 高亮框 等)整棵子树剪掉:
    // 不发号、不递归、也不进 DOM 文本。否则覆盖层里那个发光箭头 svg 会被视觉模型当成发送键(真机 bug;
    // 无此类覆盖层)。这是元素真正被收集+序列化的总点,在此剪 = 所有下游一并干净。
    if (node.nodeType === 1 && isFanOverlayNode(node)) return false
    // These source/metadata subtrees are not page evidence. Their payload is
    // represented by child text nodes, so pruning only the parent tag leaks
    // minified code into the observation (especially from attached frames).
    if (node.nodeType === 1 && MODEL_SNAPSHOT_SKIP_SUBTREE_TAGS.has(node.tag)) return false
    // <page_stats> total_elements:每访问一个(已剪掉覆盖层的)节点 +1,与 traverse_node 的
    // total_elements 同口径(在 node_type 分支之前无条件计,含元素/文本/文档/shadow 根)。
    stats.totalElements += 1
    if (node.nodeType === 1 && attributesSignalEditorHost(node.attributes, node.tag)) {
      // An editor's accessible name identifies the control, but its descendant
      // text is the actual current value. Prefer that value in both the
      // structured element and the serialized snapshot.
      const editorText = compact(snapshotTextContent(node), 500)
      if (editorText) node.text = editorText
    }
    if (node.interactive && !node.excludedByParent && !node.ignoredByPaintOrder && elements.length < maxElements) {
      // 索引用 CDP backendNodeId 稳定身份键(对齐 selector_map[backend_node_id]):
      // 跨观察/跨合并同一元素恒同号,根治位置序号 churn/串号/间歇丢号。无 backendNodeId 时
      // 回退位置序号(enhanced 路径节点几乎恒有 backendNodeId)。nextIndex 仅作兜底+计数。
      node.index = node.backendNodeId != null ? Number(node.backendNodeId) : nextIndex
      nextIndex += 1
      node.isNew = node.backendNodeId ? !previousBackendIds.has(Number(node.backendNodeId)) : false
      const shadowHost = compactShadowHostEvidence(node)
      elements.push({
        index: node.index,
        tag: node.tag,
        role: node.role,
        ...structuredElementFieldsFor(node.tag, node.attributes, {
          accessibilityName: node.name || '',
          liveValue: node.value,
          capabilities: node.capabilities
        }),
        text: node.text,
        selector: '',
        framePath: [],
        path: [],
        source: node.source,
        backendNodeId: node.backendNodeId,
        frameId: node.frameId,
        documentUrl: node.documentUrl,
        paintOrder: node.paintOrder,
        attributes: node.attributes,
        capabilities: node.capabilities,
        disabled: node.disabled,
        readonly: node.readonly,
        scroll: null,
        scrollInfo: node.scrollInfo,
        rect: node.rect,
        isNew: node.isNew,
        ...(shadowHost ? { shadowHost } : {})
      })
      stats.interactiveCount += 1
    } else if (node.interactive && node.index == null) {
      // 交互判定通过但没拿到号。区分两种:
      //  ① 几何门都过了、纯被 maxElements 上限砍掉 → 计入 truncatedInteractiveCount,供 observe 上报
      //     截断信号不再像 300 那样静默丢控件让模型以为看全了)。
      //  ② 被 excluded/ignored 几何门挡住(本就不该发号)。
      // 两种对外都按非交互处理,使"interactive ⟺ 有号"成为不变量,序列化层永不渲染 [null](SER-03)。
      if (!node.excludedByParent && !node.ignoredByPaintOrder && elements.length >= maxElements) {
        stats.truncatedInteractiveCount += 1
      }
      node.interactive = false
    }
    for (const child of logicalChildrenFor(node)) visit(child)
    node.shouldDisplay = shouldDisplayNode(node)
    node.hasDisplayDescendant = hasDisplayDescendant(node)
    if (node.nodeType === 1) {
      stats.elementCount += 1
      if (!node.rect && node.tag === 'input' && node.type === 'file') {
        stats.noLayoutFileInputCount += 1
      }
      // <page_stats> 细分计数(口径)。node.tag 在 1638 已小写,直接比对。
      if (node.tag === 'a') stats.linkCount += 1
      else if (node.tag === 'iframe' || node.tag === 'frame') stats.iframeCount += 1
      else if (node.tag === 'img') stats.imageCount += 1
      // shadow 宿主每个只计一次,open/closed 由 markShadowHosts(1751 先于 visit 跑)预标的
      // isShadowHost / hasClosedShadowRoot 决定,等价 在宿主上按子 fragment 是否 closed 分类。
      if (node.isShadowHost) {
        if (node.hasClosedShadowRoot) stats.shadowClosedCount += 1
        else stats.shadowOpenCount += 1
      }
    } else if (node.nodeType === 3) {
      // <page_stats> text_chars:文本节点累加 strip 后字符数。
      // rawText 是未折叠的原始 nodeValue(1677,仅 nodeType===3 才填),对齐其取 node_value 的口径。
      stats.textChars += String(node.rawText || '').trim().length
    }
    return node.shouldDisplay || node.hasDisplayDescendant
  }
  for (const rootNode of traversalRoots) visit(rootNode)
  for (const documentInfo of topDocuments) {
    documentInfo.root.hasDisplayDescendant = hasDisplayDescendant(documentInfo.root)
  }

  const lines = []
  const serializedRoots = topDocuments.length ? topDocuments.map(document => document.root) : roots
  for (const root of serializedRoots) {
    const url = root.documentUrl ? ` ${JSON.stringify(root.documentUrl)}` : ''
    if (documents.length > 1 || url) lines.push(`|DOCUMENT|${url}`)
    for (const child of root.children || []) {
      if (child.shouldDisplay || child.hasDisplayDescendant) serializeEnhancedNode(child, lines, 0, stats)
    }
  }
  const browserUseLines = []
  for (const root of serializedRoots) {
    for (const child of root.children || []) {
      if (hasBrowserUseSerializableContent(child)) serializeBrowserUseNode(child, browserUseLines, 0, stats)
    }
  }

  return {
    // Mirror the exact roots used above for text serialization. Iframe-owned
    // documents are already reachable through `contentDocument`; including
    // them again as top-level roots duplicates their lines and shifts the
    // backend-node line map used when target-frame text is stitched in.
    root: serializedRoots.length === 1
      ? serializedRoots[0]
      : { tag: '#documents', children: serializedRoots },
    // SHC-3:缝合后的顶层文档根列表(已排除被 iframe 拥有的子文档,:1731),供 pageContent 的
    // Node 侧内容序列化器遍历——走 logicalChildrenFor 天然穿透 closed shadow + 同进程 iframe。
    // 不要用上面的 root:多文档时它把被 iframe 拥有的子文档当顶层重复并入会导致内容重复。
    traversalRoots,
    elements,
    text: lines.join('\n'),
    browserUseText: browserUseLines.join('\n'),
    stats,
    seenBackendNodeIds,
    state: {
      backendNodeIds: elements.map(element => Number(element.backendNodeId)).filter(Number.isFinite),
      elementCount: elements.length,
      serializedNodeCount: stats.serializedNodeCount,
      browserUseSerializedNodeCount: stats.browserUseSerializedNodeCount
    }
  }
}

function buildSnapshotElements(snapshot, { startIndex = 1, maxElements = 300, jsClickListenerBackendIds = null, devicePixelRatio = 1 } = {}) {
  const strings = snapshot?.strings || []
  const documents = snapshot?.documents || []
  const jsListenerIds = jsClickListenerBackendIds instanceof Set ? jsClickListenerBackendIds : new Set(jsClickListenerBackendIds || [])
  const elements = []
  let nextIndex = Number(startIndex) || 1

  for (const document of documents) {
    if (elements.length >= maxElements) break
    const nodes = document.nodes || {}
    const layoutLookup = buildLayoutLookup(document, strings, OBSERVE_COMPUTED_STYLES, devicePixelRatio)
    const nodeNames = nodes.nodeName || []
    const nodeTypes = nodes.nodeType || []
    const backendNodeIds = nodes.backendNodeId || []
    const rawAttributes = nodes.attributes || []
    const parentIndex = nodes.parentIndex || []
    const currentUrl = readString(strings, document.documentURL)
    const frameId = readString(strings, document.frameId)

    // 预标记我方注入的覆盖层根(__fan_cursor 接管光标 / __fan_operating_frame / 高亮框 等),候选节点
    // 沿 parentIndex 上溯命中即整棵跳过——否则覆盖层里的 svg/div 会从这条扁平快照路漏进可交互元素,
    // 视觉模型把发光光标当发送箭头(真机 bug;无此类覆盖层)。enhanced 路已在 applyInteractiveDetection 剪枝。
    const _overlayRoot = new Array(nodeNames.length)
    for (let i = 0; i < nodeNames.length; i += 1) {
      if (nodeTypes[i] !== 1) continue
      const a = parseAttributes(strings, rawAttributes[i])
      const id = String(a.id || '')
      const cls = String(a.class || a.className || '')
      _overlayRoot[i] = id.indexOf('__fan_') === 0 || cls.indexOf('__fan_') !== -1
    }
    const _inFanOverlay = idx => {
      let cur = idx
      let guard = 0
      while (cur != null && cur >= 0 && guard < 80) {
        if (_overlayRoot[cur]) return true
        cur = parentIndex[cur]
        guard += 1
      }
      return false
    }

    for (let nodeIndex = 0; nodeIndex < nodeNames.length && elements.length < maxElements; nodeIndex += 1) {
      if (nodeTypes[nodeIndex] !== 1) continue
      if (_inFanOverlay(nodeIndex)) continue
      const tag = readString(strings, nodeNames[nodeIndex]).toLowerCase()
      if (!tag || tag === '#document') continue
      const attributes = parseAttributes(strings, rawAttributes[nodeIndex])
      applyLiveFormState(nodes, nodeIndex, tag, attributes)
      const layoutInfo = layoutLookup.get(nodeIndex)
      const rect = layoutInfo?.bounds
      if (!rect) continue
      if (layoutInfo.computedStyles?.display === 'none' || layoutInfo.computedStyles?.visibility === 'hidden') continue
      if (_opacityHidden(layoutInfo.computedStyles)) continue
      const backendNodeId = backendNodeIds[nodeIndex] || null
      const hasJsClickListener = backendNodeId != null && jsListenerIds.has(Number(backendNodeId))
      if (
        parseRareBoolean(nodes.isClickable, nodeIndex) === false &&
        !isInteractiveNode({ attributes, layoutInfo, tag, node: { hasJsClickListener } })
      ) {
        continue
      }
      const textFromLayout = readString(strings, layoutInfo.textIndex)
      const capturedLiveValue = tag === 'input' || tag === 'textarea'
        ? compact(parseRareString(strings, nodes.inputValue, nodeIndex) || '', 500)
        : ''
      const hasCapturedLiveValue = (tag === 'input' || tag === 'textarea') &&
        hasRareValue(nodes.inputValue, nodeIndex)
      const passwordInput = isPasswordInput(tag, attributes)
      const sensitiveValues = passwordInput
        ? collectPasswordSensitiveValues(attributes, capturedLiveValue)
        : new Set()
      scrubSensitiveControlAttributes(
        tag,
        attributes,
        passwordInput && hasCapturedLiveValue ? Boolean(capturedLiveValue) : undefined,
        sensitiveValues
      )
      const rawText = textFor(strings, nodes, nodeIndex, tag, attributes, sensitiveValues) || textFromLayout
      const text = compact(passwordInput ? redactPasswordString(rawText, sensitiveValues) : rawText)
      const liveValue = tag === 'input' || tag === 'textarea'
        ? (passwordInput
            ? attributes.value
            : capturedLiveValue || undefined)
        : undefined
      const capabilities = capabilitiesFor(tag, attributes, layoutInfo)
      const structuredFields = structuredElementFieldsFor(tag, attributes, {
        liveValue,
        capabilities
      })
      const item = {
        index: nextIndex,
        tag,
        role: String(attributes.role || ''),
        ...structuredFields,
        text,
        selector: '',
        framePath: [],
        path: [],
        source: 'snapshot',
        backendNodeId,
        frameId,
        documentUrl: currentUrl,
        paintOrder: layoutInfo.paintOrder ?? null,
        attributes,
        capabilities,
        disabled: attributesSignalDisabled(attributes),
        readonly: attributesSignalReadOnly(attributes),
        scroll: null,
        scrollInfo: scrollInfoFor(layoutInfo),
        rect,
        hasJsClickListener
      }
      elements.push(item)
      nextIndex += 1
    }
  }

  return {
    elements,
    stats: {
      documentCount: documents.length,
      elementCount: elements.length
    }
  }
}

function mergeObservedElements(primary = [], secondary = [], maxElements = 300) {
  const merged = []
  const seenBn = new Set()   // backendNodeId 身份键(权威源:enhanced/snapshot/dom-document)
  const seenGeo = new Set()  // 几何指纹(frameId|tag|text|rect),用于把【无 backendNodeId 的 in-page 兜底】
  // 去重掉它对应的权威元素——这类元素拿不到 CDP backendNodeId,身份只能靠几何。
  // 几何指纹只用 tag+rect:in-page 兜底元素拿不到 backendNodeId,且没有 frameId、text 口径
  // 也可能与权威源略异,但 DPR 归一后 rect 已一致 → tag+整数 rect 是最稳的跨源身份。
  const geoSig = element => {
    const rect = element.rect || {}
    return [
      element.tag || '',
      Math.round(Number(rect.left || rect.x || 0)),
      Math.round(Number(rect.top || rect.y || 0)),
      Math.round(Number(rect.width || 0)),
      Math.round(Number(rect.height || 0))
    ].join('|')
  }
  const add = element => {
    if (!element || merged.length >= maxElements) return
    const bn = element.backendNodeId
    const geo = geoSig(element)
    if (bn != null && bn !== '') {
      const bnKey = `bn:${element.frameId || ''}:${bn}`
      if (seenBn.has(bnKey)) return        // 同一 backendNodeId 已收(权威去重)
      seenBn.add(bnKey)
      seenGeo.add(geo)                       // 登记几何,后来的 no-bn 兜底重复会被命中丢弃
    } else {
      // 无 backendNodeId(in-page 兜底):若某权威元素已占同一几何位置,则它是冗余重复 → 丢弃
      if (seenGeo.has(geo)) return
      seenGeo.add(geo)
    }
    // 保留元素自己的 index(enhanced/snapshot/dom-document 已是 backendNodeId 稳定键);
    // 不再 merged.length+1 整体重排——那会把 backendNodeId 号覆盖成数组序、与序列化文本/
    // selectorMap 解耦(reindex/串号根源)。
    const copy = withAutocompleteSemantics({ ...element })
    if (copy.selector && copy.selectorIndex == null && Number.isFinite(Number(copy.index))) {
      // The page-injected selector map remains keyed by its original local
      // index even when the model-facing index is later made globally unique.
      copy.selectorIndex = Number(copy.index)
    }
    merged.push(copy)
  }
  primary.forEach(add)
  secondary.forEach(add)
  // 无 backendNodeId 的 in-page 兜底元素:重新分配到所有 backendNodeId 之上的号段,杜绝与
  // 身份号冲突(派生自 maxBn,非臆造常量)。这类元素经 selector 解析,index 仅作显示/查找键。
  let maxBn = 0
  for (const e of merged) {
    const n = Number(e.backendNodeId)
    if (Number.isFinite(n) && n > maxBn) maxBn = n
  }
  let extra = 0
  for (const e of merged) {
    if (e.backendNodeId == null || e.backendNodeId === '') e.index = maxBn + (++extra)
  }
  return merged
}

// ───────────────────────────────────────────────────────────────────────────
// SHC-3:pageContent 用的 Node 侧内容序列化器。消费 buildEnhancedSnapshotState 的
// traversalRoots,走 logicalChildrenFor 穿透 closed shadow + 同进程 iframe(跨进程 OOPIF
// 由 pageContent 逐 session 各抓一棵树补齐)。规则逐条移植自 content-extractor.cjs 的 live-DOM
// 版(serializeHtml/markdownNode),仅把数据访问从 live-DOM 换成快照节点字段。
// ───────────────────────────────────────────────────────────────────────────
const CONTENT_SKIP_TAGS = new Set(['script', 'style', 'head', 'meta', 'link', 'title', 'noscript'])
const CONTENT_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function contentCompact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}
function escapeContentHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeContentAttr(value) {
  return escapeContentHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}
// 移植 isHiddenElement:el.hidden→attributes.hidden;aria-hidden 同名;getComputedStyle→isCssHiddenNode。
function isHiddenContentNode(node) {
  if (!node || node.nodeType !== 1) return false
  const attrs = node.attributes || {}
  if (attrs.hidden != null || attrs['aria-hidden'] === 'true') return true
  return isCssHiddenNode(node)
}
// 移植 isNoisyCodeElement。getAttribute→attributes[x]。逻辑逐字保留。
function isNoisyContentCode(node) {
  if (!node || node.tag !== 'code') return false
  const attrs = node.attributes || {}
  const style = String(attrs.style || '').replace(/\s+/g, '').toLowerCase()
  const id = String(attrs.id || '').toLowerCase()
  if (style.indexOf('display:none') >= 0) return true
  return id.indexOf('bpr-guid') >= 0 || id.indexOf('data') >= 0 || id.indexOf('state') >= 0
}
// 移植 serializeAttributes。el.attributes 数组→Object.entries 对象。门控逐字保留。
function serializeContentAttributes(node, ctx) {
  const parts = []
  const tag = node.tag
  const attrs = isPasswordInput(tag, node.attributes || {})
    ? scrubSensitiveControlAttributes(tag, { ...(node.attributes || {}) })
    : (node.attributes || {})
  for (const [name, value] of Object.entries(attrs)) {
    if (!name || name.indexOf('data-') === 0) continue
    if (name === 'href' && !ctx.extractLinks) continue
    if (name === 'src' && tag === 'img' && !ctx.extractImages) continue
    if (value === '') parts.push(name)
    else parts.push(name + '="' + escapeContentAttr(value) + '"')
  }
  return parts.length ? ' ' + parts.join(' ') : ''
}
// textContent 无快照等价 → 递归拼接后代 nodeType===3 子节点的 .text(SKIP/hidden 过滤)。
function snapshotTextContent(node) {
  if (!node) return ''
  if (node.nodeType === 3) return (node.text || '') + ' '
  if (node.nodeType === 1 && (CONTENT_SKIP_TAGS.has(node.tag) || isHiddenContentNode(node))) return ''
  let out = ''
  for (const child of logicalChildrenFor(node)) out += snapshotTextContent(child)
  return out
}
// SHC-3/C4b:<pre> 用未折叠的原始文本,保留内部换行(rawText 缺省回落 text)。
function snapshotRawTextContent(node) {
  if (!node) return ''
  if (node.nodeType === 3) return node.rawText != null && node.rawText !== '' ? node.rawText : (node.text || '')
  if (node.nodeType === 1 && (CONTENT_SKIP_TAGS.has(node.tag) || isHiddenContentNode(node))) return ''
  let out = ''
  for (const child of logicalChildrenFor(node)) out += snapshotRawTextContent(child)
  return out
}
// SHC-3/C4a:相对 href/src 用节点所属文档 URL 绝对化(快照只有原始属性值,无 IDL 绝对 URL)。失败回落原值。
function absolutizeUrl(value, base) {
  const v = String(value || '')
  if (!v || !base) return v
  try { return new URL(v, base).href } catch { return v }
}
// 移植 querySelectorAll('tr') → 递归收集后代 tr。
function collectSnapshotRows(node, out = []) {
  if (!node) return out
  for (const child of logicalChildrenFor(node)) {
    if (child.nodeType === 1 && child.tag === 'tr') out.push(child)
    collectSnapshotRows(child, out)
  }
  return out
}
function snapshotElementChildren(node) {
  return logicalChildrenFor(node).filter(child => child && child.nodeType === 1)
}
// 移植 serializeTableChildren(逐字对齐含 break 在 if 外只看首个 tr)。
function serializeSnapshotTableChildren(node, ctx) {
  const ser = child => serializeSnapshotHtml(child, ctx)
  const children = snapshotElementChildren(node)
  if (!children.length) return logicalChildrenFor(node).map(ser).join('')
  const tags = children.map(child => child.tag)
  if (tags.indexOf('thead') >= 0) return logicalChildrenFor(node).map(ser).join('')
  if (children.length === 1 && tags[0] === 'tbody') {
    const tbodyRows = snapshotElementChildren(children[0])
    const firstTbodyRow = tbodyRows[0]
    const firstTbodyRowHasTh = firstTbodyRow && snapshotElementChildren(firstTbodyRow).some(cell => cell.tag === 'th')
    if (firstTbodyRowHasTh) {
      return '<thead>' + ser(firstTbodyRow) + '</thead><tbody>' + tbodyRows.slice(1).map(ser).join('') + '</tbody>'
    }
  }
  let firstTrIndex = -1
  let firstTr = null
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.tag !== 'tr') continue
    const hasTh = snapshotElementChildren(child).some(cell => cell.tag === 'th')
    if (hasTh) { firstTrIndex = i; firstTr = child }
    break
  }
  if (!firstTr) return logicalChildrenFor(node).map(ser).join('')
  let html = ''
  children.slice(0, firstTrIndex).forEach(child => { html += ser(child) })
  html += '<thead>' + ser(firstTr) + '</thead>'
  const remaining = children.slice(firstTrIndex + 1)
  if (remaining.length && tags.indexOf('tbody') < 0) html += '<tbody>' + remaining.map(ser).join('') + '</tbody>'
  else html += remaining.map(ser).join('')
  return html
}
// 移植 serializeHtml。closed shadow → '<template shadowroot="closed">'(对齐 BU);iframe 走 logicalChildrenFor。
function serializeSnapshotHtml(node, ctx) {
  if (!node) return ''
  if (node.nodeType === 9) return logicalChildrenFor(node).map(child => serializeSnapshotHtml(child, ctx)).join('')
  if (node.nodeType === 11 && node.shadowRootType) {
    const mode = String(node.shadowRootType).toLowerCase() === 'closed' ? 'closed' : 'open'
    return '<template shadowroot="' + mode + '">' + logicalChildrenFor(node).map(child => serializeSnapshotHtml(child, ctx)).join('') + '</template>'
  }
  if (node.nodeType === 3) return escapeContentHtml(node.text || '')
  if (node.nodeType !== 1) return ''
  const tag = node.tag
  if (CONTENT_SKIP_TAGS.has(tag) || isHiddenContentNode(node)) return ''
  if (isNoisyContentCode(node)) return ''
  if (tag === 'img' && String((node.attributes || {}).src || '').startsWith('data:image/')) return ''
  let html = '<' + tag + serializeContentAttributes(node, ctx)
  if (CONTENT_VOID_TAGS.has(tag)) {
    html += ' />'
  } else {
    html += '>'
    if (tag === 'iframe' || tag === 'frame') {
      // logicalChildrenFor 已把 contentDocument.children 并入(:777),不再手拼,防双重并入。
      html += logicalChildrenFor(node).map(child => serializeSnapshotHtml(child, ctx)).join('')
    } else if (tag === 'table') {
      html += serializeSnapshotTableChildren(node, ctx)
    } else {
      html += logicalChildrenFor(node).map(child => serializeSnapshotHtml(child, ctx)).join('')
    }
    html += '</' + tag + '>'
  }
  // SHC-3:真 DOMSnapshot 把 shadow root 折叠成【带 shadowRootType 的内容根元素(nodeType 1)】,
  // 不是独立 nodeType 11 节点。给它套 <template shadowroot="open|closed"> 还原 BU 输出
  // (对齐 BU html_serializer.py)。文本/markdown 路径不需此标记,故只在 HTML 序列化处理。
  if (node.shadowRootType) {
    const mode = String(node.shadowRootType).toLowerCase() === 'closed' ? 'closed' : 'open'
    return '<template shadowroot="' + mode + '">' + html + '</template>'
  }
  return html
}
// ── markdown(移植 content-extractor markdownNode 及其 helper)──
function markdownContentEscape(value) {
  return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
}
function markdownSnapshotChildren(node, depth, ctx) {
  return logicalChildrenFor(node).map(child => markdownSnapshotNode(child, depth, ctx)).join('')
}
function markdownSnapshotInline(node, depth, ctx) {
  return markdownContentEscape(markdownSnapshotChildren(node, depth, ctx)).replace(/\n+/g, ' ').trim()
}
function markdownSnapshotList(node, depth, ordered, ctx) {
  let index = 1
  return '\n' + snapshotElementChildren(node).map(child => {
    if (child.tag === 'li') {
      const marker = ordered ? (index++) + '. ' : '- '
      let inline = ''
      let nested = ''
      for (const liChild of logicalChildrenFor(child)) {
        if (liChild.nodeType === 1 && (liChild.tag === 'ul' || liChild.tag === 'ol')) nested += markdownSnapshotNode(liChild, depth + 1, ctx)
        else inline += markdownSnapshotNode(liChild, depth + 1, ctx)
      }
      const line = '  '.repeat(depth) + marker + markdownContentEscape(inline).replace(/\n+/g, ' ').trim()
      return line + '\n' + nested.replace(/^\n+/, '')
    }
    return markdownSnapshotNode(child, depth, ctx)
  }).join('') + '\n'
}
// SHC-4:单元格转义字面 | / 换行,否则会把表格列冲乱
function mdTableCell(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
function markdownSnapshotTable(node) {
  // SHC-4:去掉 .slice(0,200) 人为行上限(对齐 无上限),否则 >200 行的表(电商/排行/流水)
  // 第 200 行后的数据对模型彻底消失,"找第 N 条"必错。
  const rows = collectSnapshotRows(node).map(row => snapshotElementChildren(row).map(cell => mdTableCell(contentCompact(snapshotTextContent(cell))))).filter(row => row.length)
  if (!rows.length) return ''
  const width = Math.max.apply(null, rows.map(row => row.length))
  const out = rows.map(row => {
    const cells = row.slice()
    while (cells.length < width) cells.push('')
    return '| ' + cells.join(' | ') + ' |'
  })
  if (out.length > 1) out.splice(1, 0, '| ' + Array(width).fill('---').join(' | ') + ' |')
  return '\n' + out.join('\n') + '\n\n'
}
function markdownSnapshotNode(node, depth, ctx) {
  if (!node) return ''
  if (node.nodeType === 3) return node.text || ''
  if (node.nodeType === 9 || node.nodeType === 11) return markdownSnapshotChildren(node, depth, ctx)
  if (node.nodeType !== 1) return ''
  const tag = node.tag
  if (CONTENT_SKIP_TAGS.has(tag) || isHiddenContentNode(node)) return ''
  if (/^h[1-6]$/.test(tag)) {
    const heading = markdownSnapshotInline(node, depth, ctx) || contentCompact(snapshotTextContent(node))
    return '\n' + '#'.repeat(Number(tag[1])) + ' ' + heading + '\n\n'
  }
  if (tag === 'br') return '\n'
  if (tag === 'pre') {
    const fence = '```'
    // C4b:用 rawText 保留代码块内部换行(snapshotTextContent 的 text 已折叠空白)
    return '\n' + fence + '\n' + String(snapshotRawTextContent(node) || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim() + '\n' + fence + '\n\n'
  }
  if (tag === 'code') {
    if (isNoisyContentCode(node)) return ''
    return '`' + contentCompact(snapshotTextContent(node)) + '`'
  }
  if (tag === 'strong' || tag === 'b') {
    const strong = markdownSnapshotInline(node, depth, ctx)
    return strong ? '**' + strong + '**' : ''
  }
  if (tag === 'em' || tag === 'i') {
    const emphasis = markdownSnapshotInline(node, depth, ctx)
    return emphasis ? '*' + emphasis + '*' : ''
  }
  if (tag === 'a') {
    const attrs = node.attributes || {}
    const href = absolutizeUrl(attrs.href, node.documentUrl)   // C4a:相对链接绝对化
    const label = markdownSnapshotInline(node, depth, ctx) || contentCompact(snapshotTextContent(node)) || href
    return ctx.extractLinks && href ? '[' + label + '](' + href + ')' : label
  }
  if (tag === 'img') {
    const attrs = node.attributes || {}
    if (!ctx.extractImages) return contentCompact(attrs.alt || '')
    const alt = contentCompact(attrs.alt || 'image')
    const src = absolutizeUrl(attrs.src, node.documentUrl)     // C4a:相对图片地址绝对化
    return src && !src.startsWith('data:image/') ? '![' + alt + '](' + src + ')' : alt
  }
  if (tag === 'ul' || tag === 'ol') return markdownSnapshotList(node, depth, tag === 'ol', ctx)
  if (tag === 'table') return markdownSnapshotTable(node)
  let body = markdownSnapshotChildren(node, depth, ctx)
  if (['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav'].includes(tag)) {
    body = markdownContentEscape(body)
    return body ? body + '\n\n' : ''
  }
  return body
}
// 找首个后代 body(替代 live 的 document.body)。
function findFirstSnapshotBody(roots) {
  const stack = [...roots]
  while (stack.length) {
    const node = stack.shift()
    if (!node) continue
    if (node.nodeType === 1 && node.tag === 'body') return node
    for (const child of logicalChildrenFor(node)) stack.push(child)
  }
  return null
}
// 顶层入口:消费 traversalRoots,产出 {ok, content, stats}。html 从文档根;markdown/text 从 body。
function serializeSnapshotContent(roots, { format = 'markdown', extractLinks = false, extractImages = false } = {}) {
  const list = Array.isArray(roots) ? roots.filter(Boolean) : (roots ? [roots] : [])
  if (!list.length) return { ok: false, error: 'no snapshot roots', content: '', stats: {} }
  const ctx = { extractLinks: Boolean(extractLinks), extractImages: Boolean(extractImages) }
  const html = list.map(root => serializeSnapshotHtml(root, ctx)).join('')
  const bodyNodes = list.map(root => findFirstSnapshotBody([root]) || root)
  const rawMarkdown = markdownContentEscape(bodyNodes.map(body => markdownSnapshotNode(body, 0, ctx)).join('\n'))
  const markdownResult = preprocessMarkdownContent(rawMarkdown)
  const markdown = markdownResult.content
  const text = contentCompact(bodyNodes.map(body => snapshotTextContent(body)).join(' '))
  const content = format === 'html' ? html : format === 'text' ? text : markdown
  return {
    ok: true,
    format,
    content,
    stats: {
      htmlChars: html.length,
      markdownChars: markdown.length,
      filteredCharsRemoved: markdownResult.filteredCharsRemoved,
      textChars: text.length,
      contentChars: content.length,
      extractLinks: ctx.extractLinks,
      extractImages: ctx.extractImages,
      documentCount: list.length,
      url: String((list[0] && list[0].documentUrl) || '')
    }
  }
}

module.exports = {
  OBSERVE_COMPUTED_STYLES,
  buildDomDocumentElements,
  buildEnhancedSnapshotState,
  buildSnapshotElements,
  mergeObservedElements,
  snapshotBelongsToTarget,
  snapshotCaptureParams,
  snapshotDocumentUrls,
  serializedBackendNodeLineIndexes,
  serializeSnapshotContent
}
