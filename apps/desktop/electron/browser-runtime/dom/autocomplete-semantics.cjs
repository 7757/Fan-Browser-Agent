'use strict'

const FALSE_TOKENS = new Set(['false', '0', 'no', 'off', 'none'])
const ARIA_AUTOCOMPLETE_MODES = new Set(['list', 'inline', 'both'])

function normalizedToken(value) {
  return String(value ?? '').trim().toLowerCase()
}

function hasOwnAttribute(attributes, name) {
  return Boolean(
    attributes &&
    typeof attributes === 'object' &&
    Object.prototype.hasOwnProperty.call(attributes, name)
  )
}

function enabledToken(value) {
  if (value == null) return false
  const token = normalizedToken(value)
  return Boolean(token) && !FALSE_TOKENS.has(token)
}

function autocompleteMetadataFor(element = {}) {
  const attributes = element.attributes && typeof element.attributes === 'object'
    ? element.attributes
    : {}
  const tag = normalizedToken(element.tag)
  const type = normalizedToken(element.type || attributes.type)
  const role = normalizedToken(element.role || attributes.role)
  const ariaAutocomplete = normalizedToken(attributes['aria-autocomplete'])
  const hasAriaAutocomplete = ARIA_AUTOCOMPLETE_MODES.has(ariaAutocomplete)
  const hasList = Boolean(String(attributes.list || '').trim())
  const popupValue = attributes['aria-haspopup'] ?? attributes.haspopup
  const popupToken = normalizedToken(popupValue)
  const hasPopup = enabledToken(popupValue)
  const controls = String(attributes['aria-controls'] || '').trim()
  const owns = String(attributes['aria-owns'] || '').trim()
  const hasExpanded = hasOwnAttribute(attributes, 'aria-expanded') ||
    hasOwnAttribute(attributes, 'expanded')
  const expandedToken = normalizedToken(
    attributes['aria-expanded'] ?? attributes.expanded
  )
  const contentEditable = normalizedToken(attributes.contenteditable)
  const axEditable = normalizedToken(attributes.editable)
  const editableHost = Boolean(
    (
      hasOwnAttribute(attributes, 'contenteditable') &&
      ['', 'true', 'plaintext-only'].includes(contentEditable)
    ) ||
    ['true', 'plaintext', 'richtext'].includes(axEditable)
  )
  const excludedInputTypes = new Set([
    'button', 'checkbox', 'color', 'file', 'hidden', 'image',
    'radio', 'range', 'reset', 'submit'
  ])
  const textLike = Boolean(
    element.capabilities?.typeable === true ||
    editableHost ||
    tag === 'textarea' ||
    (tag === 'input' && !excludedInputTypes.has(type)) ||
    ['textbox', 'searchbox'].includes(role)
  )
  // Chromium exposes a native <select> as role=combobox too. That is a
  // deterministic selection control, not an editable autocomplete field.
  const editableCombobox = role === 'combobox' && textLike
  const controlledPopup = Boolean(
    textLike &&
    (controls || owns) &&
    (hasPopup || hasExpanded)
  )
  const detected = Boolean(
    editableCombobox ||
    (textLike && hasAriaAutocomplete) ||
    (textLike && hasList) ||
    controlledPopup
  )

  if (!detected) {
    return {
      detected: false,
      shouldWait: false,
      role,
      ariaAutocomplete: '',
      hasList: false,
      hasPopup: false
    }
  }

  const evidence = []
  if (editableCombobox) evidence.push('role')
  if (hasAriaAutocomplete) evidence.push('aria-autocomplete')
  if (hasList) evidence.push('list')
  if (hasPopup) evidence.push('aria-haspopup')
  if (controls) evidence.push('aria-controls')
  if (owns) evidence.push('aria-owns')
  if (hasExpanded) evidence.push('aria-expanded')

  let mode = ariaAutocomplete
  if (!mode && hasList) mode = 'datalist'
  if (!mode && editableCombobox) mode = 'combobox'
  if (!mode && popupToken && popupToken !== 'true') mode = popupToken
  if (!mode && hasPopup) mode = 'popup'
  if (!mode) mode = 'controlled'

  return {
    detected: true,
    mode,
    shouldWait: !hasList,
    role,
    ariaAutocomplete: hasAriaAutocomplete ? ariaAutocomplete : '',
    hasList,
    hasPopup,
    ...(controls ? { controls } : {}),
    ...(owns ? { owns } : {}),
    ...(hasExpanded
      ? { expanded: !FALSE_TOKENS.has(expandedToken) }
      : {}),
    evidence
  }
}

function withAutocompleteSemantics(element = {}) {
  if (!element || typeof element !== 'object' || Array.isArray(element)) return element
  const metadata = autocompleteMetadataFor(element)
  if (!metadata.detected) return element
  return {
    ...element,
    autocomplete: metadata
  }
}

module.exports = {
  autocompleteMetadataFor,
  withAutocompleteSemantics
}
