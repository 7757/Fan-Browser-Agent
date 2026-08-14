function coerceLimitedInteger(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

function searchPageExpression({ pattern, regex, caseSensitive, contextChars, cssScope, maxResults }) {
  return `(function() {
var PATTERN = ${JSON.stringify(pattern)};
var IS_REGEX = ${JSON.stringify(Boolean(regex))};
var CASE_SENSITIVE = ${JSON.stringify(Boolean(caseSensitive))};
var CONTEXT_CHARS = ${JSON.stringify(contextChars)};
var CSS_SCOPE = ${JSON.stringify(cssScope || null)};
var MAX_RESULTS = ${JSON.stringify(maxResults)};
try {
  var scope = CSS_SCOPE ? document.querySelector(CSS_SCOPE) : document.body;
  if (!scope) {
    return {error: 'CSS scope selector not found: ' + CSS_SCOPE, matches: [], total: 0};
  }
  var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  var fullText = '';
  var nodeOffsets = [];
  while (walker.nextNode()) {
    var node = walker.currentNode;
    var text = node.textContent;
    if (text && text.trim()) {
      nodeOffsets.push({offset: fullText.length, length: text.length, node: node});
      fullText += text;
    }
  }
  var re;
  try {
    var flags = CASE_SENSITIVE ? 'g' : 'gi';
    if (IS_REGEX) {
      re = new RegExp(PATTERN, flags);
    } else {
      re = new RegExp(_escapeRegExp(PATTERN), flags);
    }
  } catch (e) {
    return {error: 'Invalid regex pattern: ' + e.message, matches: [], total: 0};
  }
  var matches = [];
  var match;
  var totalFound = 0;
  while ((match = re.exec(fullText)) !== null) {
    totalFound++;
    if (matches.length < MAX_RESULTS) {
      var start = Math.max(0, match.index - CONTEXT_CHARS);
      var end = Math.min(fullText.length, match.index + match[0].length + CONTEXT_CHARS);
      var context = fullText.slice(start, end);
      var elementPath = '';
      for (var i = 0; i < nodeOffsets.length; i++) {
        var no = nodeOffsets[i];
        if (no.offset <= match.index && no.offset + no.length > match.index) {
          elementPath = _getPath(no.node.parentElement);
          break;
        }
      }
      matches.push({
        match_text: match[0],
        context: (start > 0 ? '...' : '') + context + (end < fullText.length ? '...' : ''),
        element_path: elementPath,
        char_position: match.index
      });
    }
    if (match[0].length === 0) re.lastIndex++;
  }
  return {matches: matches, total: totalFound, has_more: totalFound > MAX_RESULTS};
} catch (e) {
  return {error: 'search_page error: ' + e.message, matches: [], total: 0};
}
function _getPath(el) {
  var parts = [];
  var current = el;
  while (current && current !== document.body && current !== document) {
    var desc = current.tagName ? current.tagName.toLowerCase() : '';
    if (!desc) break;
    if (current.id) desc += '#' + current.id;
    else if (current.className && typeof current.className === 'string') {
      var classes = current.className.trim().split(/\\s+/).slice(0, 2).join('.');
      if (classes) desc += '.' + classes;
    }
    parts.unshift(desc);
    current = current.parentElement;
  }
  return parts.join(' > ');
}
function _escapeRegExp(value) {
  return String(value).replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&');
}
})()`
}

function formatSearchPageResults(data, pattern) {
  if (!data || typeof data !== 'object') return `search_page returned unexpected result: ${String(data)}`
  const matches = Array.isArray(data.matches) ? data.matches : []
  const total = Number(data.total || 0)
  if (total === 0) return `No matches found for "${pattern}" on page.`
  const lines = [`Found ${total} match${total === 1 ? '' : 'es'} for "${pattern}" on page:`, '']
  matches.forEach((match, index) => {
    const context = String(match.context || '')
    const pathLabel = match.element_path ? ` (in ${match.element_path})` : ''
    lines.push(`[${index + 1}] ${context}${pathLabel}`)
  })
  if (data.has_more) {
    lines.push(`\n... showing ${matches.length} of ${total} total matches. Increase max_results to see more.`)
  }
  return lines.join('\n')
}

function findElementsExpression({ selector, attributes, maxResults, includeText, actionableCandidates = [] }) {
  return `(function() {
var SELECTOR = ${JSON.stringify(selector)};
var ATTRIBUTES = ${JSON.stringify(attributes)};
var MAX_RESULTS = ${JSON.stringify(maxResults)};
var INCLUDE_TEXT = ${JSON.stringify(Boolean(includeText))};
var ACTIONABLE_CANDIDATES = ${JSON.stringify(actionableCandidates)};
try {
  var elements;
  try {
    elements = document.querySelectorAll(SELECTOR);
  } catch (e) {
    return {error: 'Invalid CSS selector: ' + e.message, elements: [], total: 0};
  }
  var total = elements.length;
  var limit = Math.min(total, MAX_RESULTS);
  var results = [];
  for (var i = 0; i < limit; i++) {
    var el = elements[i];
    var actionable = null;
    for (var candidateIndex = 0; candidateIndex < ACTIONABLE_CANDIDATES.length; candidateIndex++) {
      var candidate = ACTIONABLE_CANDIDATES[candidateIndex];
      if (!candidate || !candidate.selector) continue;
      try {
        var candidateNodes = document.querySelectorAll(candidate.selector);
        for (var nodeIndex = 0; nodeIndex < candidateNodes.length; nodeIndex++) {
          if (candidateNodes[nodeIndex] === el) { actionable = candidate; break; }
        }
      } catch (e) { void e; }
      if (actionable) break;
    }
    var item = {
      index: actionable ? actionable.index : null,
      match_ordinal: i + 1,
      actionable: Boolean(actionable),
      tag: el.tagName.toLowerCase()
    };
    if (actionable && actionable.selector) item.actionable_selector = actionable.selector;
    if (INCLUDE_TEXT) {
      var text = (el.textContent || '').trim();
      item.text = text.length > 300 ? text.slice(0, 300) + '...' : text;
    }
    if (ATTRIBUTES && ATTRIBUTES.length > 0) {
      item.attrs = {};
      for (var j = 0; j < ATTRIBUTES.length; j++) {
        var attrName = ATTRIBUTES[j];
        var val;
        if ((attrName === 'src' || attrName === 'href') && typeof el[attrName] === 'string' && el[attrName] !== '') {
          val = el[attrName];
        } else {
          val = el.getAttribute(attrName);
        }
        if (val !== null) {
          item.attrs[attrName] = val.length > 500 ? val.slice(0, 500) + '...' : val;
        }
      }
    }
    item.children_count = el.children.length;
    results.push(item);
  }
  return {elements: results, total: total, showing: limit};
} catch (e) {
  return {error: 'find_elements error: ' + e.message, elements: [], total: 0};
}
})()`
}

function formatFindElementsResults(data, selector) {
  if (!data || typeof data !== 'object') return `find_elements returned unexpected result: ${String(data)}`
  const elements = Array.isArray(data.elements) ? data.elements : []
  const total = Number(data.total || 0)
  const showing = Number(data.showing || elements.length)
  if (total === 0) return `No elements found matching "${selector}".`
  const lines = [`Found ${total} element${total === 1 ? '' : 's'} matching "${selector}":`, '']
  for (const element of elements) {
    const ordinal = Number(element.match_ordinal || 0)
    const parts = [`[match ${ordinal > 0 ? ordinal : '?'}] <${element.tag || '?'}>`]
    if (element.text) {
      const displayText = String(element.text).replace(/\s+/g, ' ').trim().slice(0, 120)
      parts.push(`"${displayText}${String(element.text).replace(/\s+/g, ' ').trim().length > 120 ? '...' : ''}"`)
    }
    const attrs = element.attrs && typeof element.attrs === 'object' ? element.attrs : null
    if (attrs && Object.keys(attrs).length) {
      parts.push(`{${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(', ')}}`)
    }
    parts.push(`(${Number(element.children_count || 0)} children)`)
    if (element.actionable && Number.isFinite(Number(element.index))) {
      parts.push(`[actionable index=${Number(element.index)}]`)
    } else {
      parts.push('[read-only match; no actionable index]')
    }
    lines.push(parts.join(' '))
  }
  if (showing < total) lines.push(`\nShowing ${showing} of ${total} total elements. Increase max_results to see more.`)
  return lines.join('\n')
}

module.exports = {
  coerceLimitedInteger,
  findElementsExpression,
  formatFindElementsResults,
  formatSearchPageResults,
  searchPageExpression
}
