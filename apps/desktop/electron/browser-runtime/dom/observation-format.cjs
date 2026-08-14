const {
  serializedBackendNodeLineIndexes: collectSerializedBackendNodeLineIndexes
} = require('./snapshot-service.cjs')
const { autocompleteMetadataFor } = require('./autocomplete-semantics.cjs')

function formatElementsText(elements = []) {
  return elements
    .map(element => {
      const attrs = []
      if (element.role) attrs.push(`role=${JSON.stringify(element.role)}`)
      if (element.type) attrs.push(`type=${JSON.stringify(element.type)}`)
      if (element.attributes?.name) attrs.push(`name=${JSON.stringify(element.attributes.name)}`)
      if (element.attributes?.placeholder) attrs.push(`placeholder=${JSON.stringify(element.attributes.placeholder)}`)
      const autocomplete = element.autocomplete?.detected
        ? element.autocomplete
        : autocompleteMetadataFor(element)
      if (autocomplete.detected) {
        attrs.push(`autocomplete_kind=${JSON.stringify(autocomplete.mode)}`)
      }
      if (element.capabilities?.scrollable) attrs.push('scrollable')
      if (element.pagination?.kind) attrs.push(`pagination=${JSON.stringify(element.pagination.kind)}`)
      if (element.source === 'snapshot') attrs.push('snapshot')
      if (element.source === 'target-session') attrs.push('target')
      if (element.frameId) attrs.push(`frame=${JSON.stringify(element.frameId)}`)
      if (element.disabled) attrs.push('disabled')
      if (element.readonly) attrs.push('readonly')
      const attrText = attrs.length ? ` ${attrs.join(' ')}` : ''
      const marker = element.isNew ? '*' : ''
      return `${marker}[${element.index}]<${element.tag}${attrText}>${element.text || element.selector || element.documentUrl || ''}`
    })
    .join('\n')
}

function formatSupplementalElementsText(elements = [], options = {}, helpers = {}) {
  const formatElements = helpers.formatElementsText || formatElementsText
  const formatTargetFrame = helpers.formatTargetFrameBlock || formatTargetFrameBlock
  const ordinary = elements.filter(element => element.source !== 'target-session')
  const targetElements = elements.filter(element => element.source === 'target-session')
  const targetObservations = Array.isArray(options.targetObservations) ? options.targetObservations : []
  const sections = []
  if (ordinary.length) sections.push(`|ADDITIONAL|\n${formatElements(ordinary)}`)
  const covered = new Set()
  for (const observation of targetObservations) {
    const group = targetElements.filter(element => {
      if (observation.sessionId && element.sessionId === observation.sessionId) return true
      if (observation.targetId && element.targetId === observation.targetId) return true
      return Boolean(observation.frameId && element.frameId === observation.frameId)
    })
    for (const element of group) covered.add(element)
    sections.push(formatTargetFrame(group, '', { observation, format: options.format }))
  }
  const groups = new Map()
  for (const element of targetElements) {
    if (covered.has(element)) continue
    const key = element.frameId || element.targetId || element.sessionId || 'target-session'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(element)
  }
  for (const group of groups.values()) {
    sections.push(formatTargetFrame(group, ''))
  }
  return sections.join('\n')
}

function targetFrameHeaderAttrs(element = {}) {
  const attrs = []
  if (element.frameId) attrs.push(`frameId=${JSON.stringify(element.frameId)}`)
  if (element.parentFrameId) attrs.push(`parentFrameId=${JSON.stringify(element.parentFrameId)}`)
  if (element.targetId) attrs.push(`targetId=${JSON.stringify(element.targetId)}`)
  if (element.sessionId) attrs.push(`sessionId=${JSON.stringify(element.sessionId)}`)
  if (element.frameOwnerBackendNodeId != null) attrs.push(`ownerBackendNodeId=${JSON.stringify(element.frameOwnerBackendNodeId)}`)
  if (element.frameOwnerUnavailable) attrs.push('ownerUnavailable=true')
  if (element.targetUrl) attrs.push(`url=${JSON.stringify(element.targetUrl)}`)
  return attrs
}

function remapTargetFrameText(text = '', elements = [], indexKind = 'backendNodeId') {
  const indexes = new Map()
  for (const element of elements) {
    const localIndex = Number(indexKind === 'selectorIndex' ? element?.selectorIndex : element?.backendNodeId)
    const index = Number(element?.index)
    if (Number.isFinite(localIndex) && Number.isFinite(index)) indexes.set(String(localIndex), String(index))
  }
  return String(text || '')
    .split('\n')
    .map(line => line.replace(
      /^(\s*(?:\|SHADOW\([^)]*\)\|)?\*?(?:\|scroll element)?)\[(\d+)\](?=<)/,
      (match, prefix, localIndex) => {
        const mapped = indexes.get(localIndex)
        return mapped ? `${prefix}[${mapped}]` : match
      }
    ))
    .join('\n')
}

function formatTargetFrameBlock(elements = [], indent = '', options = {}, helpers = {}) {
  const frameHeaderAttrs = helpers.targetFrameHeaderAttrs || targetFrameHeaderAttrs
  const remapFrameText = helpers.remapTargetFrameText || remapTargetFrameText
  const formatElements = helpers.formatElementsText || formatElementsText
  const observation = options.observation || null
  const first = observation || elements[0] || {}
  const attrs = frameHeaderAttrs(first)
  const browserUseFormat = options.format === 'browser_use'
  const indexKind = browserUseFormat ? observation?.browserUseTextIndexKind : observation?.textIndexKind
  const observedText = observation
    ? remapFrameText(
        browserUseFormat ? observation.browserUseText : observation.text,
        elements,
        indexKind || 'backendNodeId'
      )
    : ''
  const representedIndexes = new Set()
  for (const line of observedText.split('\n')) {
    const match = line.match(/^\s*(?:\|SHADOW\([^)]*\)\|)?\*?(?:\|scroll element)?\[(\d+)\](?=<)/)
    if (match) representedIndexes.add(Number(match[1]))
  }
  const supplementalElements = elements.filter(element => !representedIndexes.has(Number(element.index)))
  const bodySections = []
  // DOMSnapshot text already contains the target's non-interactive content.
  // The injected-DOM fallback does not, so keep pageText alongside its indexed controls.
  if (observation?.pageText && indexKind !== 'backendNodeId') bodySections.push(String(observation.pageText))
  if (observedText) bodySections.push(observedText)
  if (supplementalElements.length) bodySections.push(formatElements(supplementalElements))
  if (!bodySections.length && elements.length) bodySections.push(formatElements(elements))
  const body = bodySections.join('\n')
    .split('\n')
    .filter(Boolean)
    .map(line => `${indent}\t${line}`)
    .join('\n')
  return [`${indent}|TARGET_FRAME ${attrs.join(' ')}|`, body].filter(Boolean).join('\n')
}

function serializedBackendNodeLineIndexes(root, options = {}) {
  return collectSerializedBackendNodeLineIndexes(root, options)
}

function stitchTargetFramesIntoDomText(domText = '', root = null, elements = [], options = {}, helpers = {}) {
  const serializedLineIndexes = helpers.serializedBackendNodeLineIndexes || serializedBackendNodeLineIndexes
  const formatTargetFrame = helpers.formatTargetFrameBlock || formatTargetFrameBlock
  const ordinary = elements.filter(element => element.source !== 'target-session')
  const targetElements = elements.filter(element => element.source === 'target-session')
  const targetObservations = Array.isArray(options.targetObservations) ? options.targetObservations : []
  if ((!targetElements.length && !targetObservations.length) || !root) {
    return {
      text: domText,
      remaining: elements,
      remainingTargetObservations: targetObservations,
      inlinedTargetFrameCount: 0
    }
  }
  const ownerLineIndexes = serializedLineIndexes(root, options)
  const descriptors = []
  const covered = new Set()
  const matchesObservation = (element, observation) => {
    if (observation.sessionId && element.sessionId === observation.sessionId) return true
    if (observation.targetId && element.targetId === observation.targetId) return true
    return Boolean(observation.frameId && element.frameId === observation.frameId)
  }
  for (const observation of targetObservations) {
    const group = targetElements.filter(element => matchesObservation(element, observation))
    for (const element of group) covered.add(element)
    descriptors.push({ observation, elements: group })
  }
  const unobservedGroups = new Map()
  for (const element of targetElements) {
    if (covered.has(element)) continue
    const key = element.frameId || element.targetId || element.sessionId || 'target-session'
    if (!unobservedGroups.has(key)) unobservedGroups.set(key, [])
    unobservedGroups.get(key).push(element)
  }
  for (const group of unobservedGroups.values()) descriptors.push({ observation: null, elements: group })

  const groups = new Map()
  const remainingTargets = []
  const remainingTargetObservations = []
  for (const descriptor of descriptors) {
    const metadata = descriptor.observation || descriptor.elements[0] || {}
    if (metadata.frameOwnerBackendNodeId == null) {
      remainingTargets.push(...descriptor.elements)
      if (descriptor.observation) remainingTargetObservations.push(descriptor.observation)
      continue
    }
    const ownerKey = String(metadata.frameOwnerBackendNodeId)
    const lineIndex = ownerLineIndexes.get(ownerKey)
    if (lineIndex == null) {
      remainingTargets.push(...descriptor.elements)
      if (descriptor.observation) remainingTargetObservations.push(descriptor.observation)
      continue
    }
    if (!groups.has(lineIndex)) groups.set(lineIndex, [])
    groups.get(lineIndex).push(descriptor)
  }
  if (!groups.size) {
    return {
      text: domText,
      remaining: ordinary.concat(remainingTargets),
      remainingTargetObservations,
      inlinedTargetFrameCount: 0
    }
  }

  const lines = String(domText || '').split('\n')
  const insertions = Array.from(groups.entries())
    .map(([lineIndex, frameDescriptors]) => {
      const parentLine = lines[lineIndex] || ''
      const parentIndent = parentLine.match(/^\t*/)?.[0] || ''
      const block = frameDescriptors.flatMap(descriptor => formatTargetFrame(
        descriptor.elements,
        `${parentIndent}\t`,
        { observation: descriptor.observation, format: options.format }
      ).split('\n'))
      return { lineIndex, block, count: frameDescriptors.length }
    })
    .sort((a, b) => b.lineIndex - a.lineIndex)

  for (const insertion of insertions) {
    lines.splice(insertion.lineIndex + 1, 0, ...insertion.block)
  }

  return {
    text: lines.join('\n'),
    remaining: ordinary.concat(remainingTargets),
    remainingTargetObservations,
    inlinedTargetFrameCount: insertions.reduce((total, insertion) => total + insertion.count, 0)
  }
}

function haystackForElement(element = {}) {
  const attributes = element.attributes || {}
  return [
    element.text,
    element.tag,
    element.role,
    element.type,
    element.selector,
    element.documentUrl,
    attributes.id,
    attributes.class,
    attributes.name,
    attributes.rel,
    attributes.href,
    attributes.title,
    attributes.alt,
    attributes.value,
    attributes.placeholder,
    attributes['aria-label'],
    attributes['data-testid'],
    attributes['data-test'],
    attributes['data-qa']
  ]
    .filter(value => value != null && String(value).trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isDisabledElement(element = {}) {
  const attributes = element.attributes || {}
  const className = String(attributes.class || '').toLowerCase()
  return Boolean(
    element.disabled ||
      attributes.disabled != null ||
      attributes['aria-disabled'] === 'true' ||
      /\b(disabled|inactive|unavailable)\b/.test(className)
  )
}

function detectPagination(elements = [], helpers = {}) {
  const elementHaystack = helpers.haystackForElement || haystackForElement
  const elementIsDisabled = helpers.isDisabledElement || isDisabledElement
  const candidates = []
  const firstByKind = new Map()
  const exactNext = /^(next|next page|more|load more|show more|>|›|»|下一页|下一頁|下页|下頁|下一|后一页|後一頁|后页|後頁|更多|加载更多|載入更多|查看更多)$/i
  const exactPrev = /^(prev|previous|previous page|back|<|‹|«|上一页|上一頁|上页|上頁|上一|前一页|前一頁|前页|前頁)$/i
  const fuzzyNext = /\b(next|load more|show more)\b|下一页|下一頁|加载更多|載入更多|查看更多/i
  const fuzzyPrev = /\b(prev|previous)\b|上一页|上一頁/i

  for (const element of elements) {
    const text = String(element.text || '').replace(/\s+/g, ' ').trim()
    const haystack = elementHaystack(element)
    const normalized = haystack.toLowerCase()
    const attributes = element.attributes || {}
    let kind = null
    if (String(attributes.rel || '').toLowerCase() === 'next') kind = 'next'
    else if (String(attributes.rel || '').toLowerCase() === 'prev') kind = 'previous'
    else if (exactNext.test(text) || fuzzyNext.test(haystack) || /page[-_ ]?next|next[-_ ]?page/.test(normalized)) {
      kind = /load more|show more|more|更多|加载更多|載入更多|查看更多/i.test(haystack) ? 'loadMore' : 'next'
    } else if (exactPrev.test(text) || fuzzyPrev.test(haystack) || /page[-_ ]?prev|prev[-_ ]?page|previous[-_ ]?page/.test(normalized)) {
      kind = 'previous'
    }

    if (!kind) continue
    const disabled = elementIsDisabled(element)
    element.pagination = { kind, disabled }
    const item = {
      index: element.index,
      kind,
      text: element.text || '',
      tag: element.tag || '',
      selector: element.selector || '',
      disabled
    }
    candidates.push(item)
    if (!disabled && !firstByKind.has(kind)) firstByKind.set(kind, item)
  }

  return {
    next: firstByKind.get('next') || null,
    previous: firstByKind.get('previous') || null,
    loadMore: firstByKind.get('loadMore') || null,
    candidates,
    hasNext: Boolean(firstByKind.get('next') || firstByKind.get('loadMore')),
    hasPrevious: Boolean(firstByKind.get('previous'))
  }
}

module.exports = {
  detectPagination,
  formatElementsText,
  formatSupplementalElementsText,
  formatTargetFrameBlock,
  haystackForElement,
  isDisabledElement,
  remapTargetFrameText,
  serializedBackendNodeLineIndexes,
  stitchTargetFramesIntoDomText,
  targetFrameHeaderAttrs
}
