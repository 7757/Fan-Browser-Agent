const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'tab',
  'textbox'
])
const AX_ATTRIBUTE_NAMES = new Set([
  'checked',
  'selected',
  'expanded',
  'pressed',
  'disabled',
  'invalid',
  'valuemin',
  'valuemax',
  'valuenow',
  'valuetext',
  'required',
  'keyshortcuts',
  'haspopup',
  'multiselectable',
  'level',
  'busy',
  'live',
  // 可交互判据(对齐 clickable_elements.py:118-128):可聚焦/可编辑/可设值
  'focusable',
  'editable',
  'settable',
  'readonly'
])
const PASSWORD_VALUE_MARKER = '[password-populated]'
const PASSWORD_VALUE_ATTRIBUTE_NAMES = new Set([
  'value',
  'valuetext',
  'valuenow',
  'aria-valuetext',
  'aria-valuenow'
])

function isPasswordElement(element = {}) {
  return String(element.tag || '').toLowerCase() === 'input' &&
    String(element.type || element.attributes?.type || '').trim().toLowerCase() === 'password'
}

function collectSensitiveValues(...sources) {
  const values = new Set()
  for (const source of sources) {
    if (source == null) continue
    if (typeof source === 'object' && !Array.isArray(source)) {
      for (const [name, value] of Object.entries(source)) {
        if (!PASSWORD_VALUE_ATTRIBUTE_NAMES.has(String(name).toLowerCase())) continue
        if (value != null && String(value) !== '' && String(value) !== PASSWORD_VALUE_MARKER) {
          values.add(String(value))
        }
      }
      continue
    }
    if (String(source) !== '' && String(source) !== PASSWORD_VALUE_MARKER) values.add(String(source))
  }
  return values
}

function redactSensitiveString(value, sensitiveValues) {
  if (value == null) return value
  return sensitiveValues.has(String(value)) ? PASSWORD_VALUE_MARKER : value
}

function scrubPasswordAttributes(attributes, sensitiveValues) {
  for (const name of Object.keys(attributes)) {
    if (PASSWORD_VALUE_ATTRIBUTE_NAMES.has(String(name).toLowerCase())) {
      delete attributes[name]
      continue
    }
    attributes[name] = redactSensitiveString(attributes[name], sensitiveValues)
  }
}

function axValue(raw) {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  if (typeof raw === 'object' && raw.value != null) return axValue(raw.value)
  return ''
}

function axAttributes(node = {}) {
  const attributes = {}
  for (const property of node.properties || []) {
    const name = String(property?.name || '')
    if (!AX_ATTRIBUTE_NAMES.has(name)) continue
    const value = axValue(property.value)
    if (value === '') continue
    // Chromium may expose readonly=false on editable controls. Unlike checked,
    // this is not useful model state and must not be merged as though the HTML
    // boolean `readonly` attribute were present.
    if (name === 'readonly' && ['false', '0', 'no', 'off'].includes(value.toLowerCase())) continue
    attributes[name] = value
  }
  return attributes
}

function buildAccessibilitySummary(axTree = {}) {
  const nodes = Array.isArray(axTree.nodes) ? axTree.nodes : []
  const byBackendNodeId = new Map()
  const interactive = []

  for (const node of nodes) {
    if (!node || node.ignored) continue
    const role = axValue(node.role).toLowerCase()
    const name = axValue(node.name)
    const backendNodeId = node.backendDOMNodeId || null
    const item = {
      nodeId: node.nodeId || '',
      backendNodeId,
      role,
      name,
      // AX 树的 value 字段:输入框/textarea 的【当前已输入值】在这(DOMSnapshot inputValue 抓不到时
      // 唯一可靠来源),用于让序列化显示用户输入了什么(修"假输入"困惑)。
      value: axValue(node.value),
      attributes: axAttributes(node),
      ignored: Boolean(node.ignored)
    }
    if (backendNodeId) byBackendNodeId.set(Number(backendNodeId), item)
    if (INTERACTIVE_AX_ROLES.has(role)) interactive.push(item)
  }

  return {
    stats: {
      nodeCount: nodes.length,
      mappedNodeCount: byBackendNodeId.size,
      interactiveCount: interactive.length
    },
    byBackendNodeId,
    interactive: interactive.slice(0, 200)
  }
}

function mergeAccessibility(elements = [], accessibility) {
  if (!accessibility?.byBackendNodeId) return elements
  return elements.map(element => {
    const backendNodeId = Number(element.backendNodeId)
    const ax = Number.isFinite(backendNodeId) ? accessibility.byBackendNodeId.get(backendNodeId) : null
    if (!ax) return element
    const passwordInput = isPasswordElement(element)
    const axAttributes = { ...(ax.attributes || {}) }
    const elementAttributes = { ...(element.attributes || {}) }
    const sensitiveValues = collectSensitiveValues(
      elementAttributes,
      axAttributes,
      element.value,
      element.liveValue,
      ax.value
    )
    let passwordPopulated = false
    if (passwordInput) {
      if (Object.hasOwn(element, 'liveValue')) {
        passwordPopulated = element.liveValue != null && String(element.liveValue) !== ''
      } else if (
        elementAttributes.value === PASSWORD_VALUE_MARKER ||
        element.value === PASSWORD_VALUE_MARKER
      ) {
        // A prior live-DOM/snapshot stage already established current state.
        passwordPopulated = true
      } else if (Object.hasOwn(ax, 'value')) {
        passwordPopulated = ax.value != null && String(ax.value) !== ''
      } else {
        passwordPopulated = sensitiveValues.size > 0
      }
      scrubPasswordAttributes(elementAttributes, sensitiveValues)
      scrubPasswordAttributes(axAttributes, sensitiveValues)
      if (passwordPopulated) elementAttributes.value = PASSWORD_VALUE_MARKER
    }
    const accessibilityName = passwordInput
      ? redactSensitiveString(ax.name, sensitiveValues)
      : ax.name
    let text = passwordInput
      ? redactSensitiveString(element.text || accessibilityName || '', sensitiveValues)
      : (element.text || accessibilityName || '')
    if (passwordInput && text === PASSWORD_VALUE_MARKER) {
      text = redactSensitiveString(
        elementAttributes['aria-label'] ||
        elementAttributes.placeholder ||
        elementAttributes.title ||
        elementAttributes.name ||
        accessibilityName ||
        PASSWORD_VALUE_MARKER,
        sensitiveValues
      )
    }
    const merged = {
      ...element,
      ...(passwordInput ? { attributes: elementAttributes } : {}),
      accessibility: {
        role: ax.role,
        name: accessibilityName,
        attributes: axAttributes,
        ...(passwordInput
          ? (passwordPopulated ? { value: PASSWORD_VALUE_MARKER } : {})
          : (ax.value ? { value: ax.value } : {}))
      },
      text
    }
    if (passwordInput) {
      delete merged.value
      delete merged.liveValue
      merged.selector = redactSensitiveString(merged.selector, sensitiveValues)
      merged.name = redactSensitiveString(merged.name, sensitiveValues)
      if (passwordPopulated) {
        merged.value = PASSWORD_VALUE_MARKER
        if (Object.hasOwn(element, 'liveValue')) merged.liveValue = PASSWORD_VALUE_MARKER
      }
    }
    return merged
  })
}

module.exports = { buildAccessibilitySummary, mergeAccessibility }
