function coerceFormat(value) {
  const format = String(value || 'markdown').toLowerCase()
  if (['markdown', 'html', 'text'].includes(format)) return format
  return 'markdown'
}

function buildPageContentExpression({ format = 'markdown', extractLinks = false, extractImages = false } = {}) {
  return `(function() {
var FORMAT = ${JSON.stringify(coerceFormat(format))};
var EXTRACT_LINKS = ${JSON.stringify(Boolean(extractLinks))};
var EXTRACT_IMAGES = ${JSON.stringify(Boolean(extractImages))};
var PASSWORD_VALUE_MARKER = '[password-populated]';
var PASSWORD_VALUE_ATTRIBUTES = new Set(['value', 'valuetext', 'valuenow', 'aria-valuetext', 'aria-valuenow']);
var PASSWORD_STATES = new WeakMap();
var PAGE_SENSITIVE_VALUES = new Set();
var SKIP_TAGS = new Set(['script', 'style', 'head', 'meta', 'link', 'title', 'noscript']);
var VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function compact(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}
function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
function isHiddenElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
  if (typeof window !== 'undefined' && window.getComputedStyle) {
    try {
      var style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return true;
    } catch (_) {}
  }
  return false;
}
function isNoisyCodeElement(el) {
  if (!el || !el.tagName || el.tagName.toLowerCase() !== 'code') return false;
  var style = String(el.getAttribute('style') || '').replace(/\\s+/g, '').toLowerCase();
  var id = String(el.getAttribute('id') || '').toLowerCase();
  if (style.indexOf('display:none') >= 0) return true;
  return id.indexOf('bpr-guid') >= 0 || id.indexOf('data') >= 0 || id.indexOf('state') >= 0;
}
function passwordStateFor(el) {
  var tagName = el && el.tagName ? el.tagName.toLowerCase() : '';
  var passwordInput = tagName === 'input' && String(el.getAttribute('type') || '').trim().toLowerCase() === 'password';
  if (!passwordInput) return {passwordInput: false, populated: false, sensitiveValues: new Set()};
  var cached = PASSWORD_STATES.get(el);
  if (cached) return cached;
  var sensitiveValues = new Set();
  PASSWORD_VALUE_ATTRIBUTES.forEach(function(name) {
    var candidate = el.getAttribute && el.getAttribute(name);
    if (candidate != null && String(candidate) !== '' && String(candidate) !== PASSWORD_VALUE_MARKER) {
      sensitiveValues.add(String(candidate));
    }
  });
  var hasLiveValue = typeof el.value === 'string';
  if (hasLiveValue && el.value !== '' && el.value !== PASSWORD_VALUE_MARKER) {
    sensitiveValues.add(String(el.value));
  }
  sensitiveValues.forEach(function(value) { PAGE_SENSITIVE_VALUES.add(value); });
  var state = {
    passwordInput: true,
    // The live property wins even when empty; the content attribute may be a
    // stale default after the user has cleared the control.
    populated: hasLiveValue ? el.value !== '' : sensitiveValues.size > 0,
    sensitiveValues: sensitiveValues
  };
  PASSWORD_STATES.set(el, state);
  return state;
}
function redactPasswordValue(value, sensitiveValues) {
  if (value == null) return value;
  return sensitiveValues.has(String(value)) ? PASSWORD_VALUE_MARKER : value;
}
function redactSensitiveContent(value) {
  var output = String(value || '');
  PAGE_SENSITIVE_VALUES.forEach(function(sensitiveValue) {
    if (!sensitiveValue) return;
    if (output === sensitiveValue) {
      output = PASSWORD_VALUE_MARKER;
    } else if (sensitiveValue.length >= 3) {
      output = output.split(sensitiveValue).join(PASSWORD_VALUE_MARKER);
    }
  });
  return output;
}
function serializeAttributes(el) {
  var parts = [];
  var tagName = el.tagName ? el.tagName.toLowerCase() : '';
  var passwordState = passwordStateFor(el);
  var passwordInput = passwordState.passwordInput;
  for (var i = 0; i < el.attributes.length; i++) {
    var attr = el.attributes[i];
    var name = attr.name;
    var value = passwordInput
      ? redactPasswordValue(attr.value, passwordState.sensitiveValues)
      : attr.value;
    if (!name || name.indexOf('data-') === 0) continue;
    if (passwordInput && PASSWORD_VALUE_ATTRIBUTES.has(String(name).toLowerCase())) continue;
    if (name === 'href' && !EXTRACT_LINKS) continue;
    if (name === 'src' && tagName === 'img' && !EXTRACT_IMAGES) continue;
    if (value === '') parts.push(name);
    else parts.push(name + '="' + escapeAttr(value) + '"');
  }
  if (passwordState.populated) parts.push('value="' + PASSWORD_VALUE_MARKER + '"');
  return parts.length ? ' ' + parts.join(' ') : '';
}
function elementChildren(node) {
  return Array.from(node.children || []).filter(function(child) { return child.nodeType === Node.ELEMENT_NODE; });
}
function serializeTableChildren(node) {
  var children = elementChildren(node);
  if (!children.length) return Array.from(node.childNodes || []).map(serializeHtml).join('');
  var tags = children.map(function(child) { return child.tagName.toLowerCase(); });
  if (tags.indexOf('thead') >= 0) return Array.from(node.childNodes || []).map(serializeHtml).join('');
  if (children.length === 1 && tags[0] === 'tbody') {
    var tbodyRows = elementChildren(children[0]);
    var firstTbodyRow = tbodyRows[0];
    var firstTbodyRowHasTh = firstTbodyRow && Array.from(firstTbodyRow.children || []).some(function(cell) {
      return cell.tagName && cell.tagName.toLowerCase() === 'th';
    });
    if (firstTbodyRowHasTh) {
      return '<thead>' + serializeHtml(firstTbodyRow) + '</thead><tbody>' + tbodyRows.slice(1).map(serializeHtml).join('') + '</tbody>';
    }
  }
  var firstTrIndex = -1;
  var firstTr = null;
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (child.tagName.toLowerCase() !== 'tr') continue;
    var hasTh = Array.from(child.children || []).some(function(cell) {
      return cell.tagName && cell.tagName.toLowerCase() === 'th';
    });
    if (hasTh) {
      firstTrIndex = i;
      firstTr = child;
    }
    break;
  }
  if (!firstTr) return Array.from(node.childNodes || []).map(serializeHtml).join('');
  var html = '';
  children.slice(0, firstTrIndex).forEach(function(child) { html += serializeHtml(child); });
  html += '<thead>' + serializeHtml(firstTr) + '</thead>';
  var remaining = children.slice(firstTrIndex + 1);
  if (remaining.length && tags.indexOf('tbody') < 0) {
    html += '<tbody>' + remaining.map(serializeHtml).join('') + '</tbody>';
  } else {
    html += remaining.map(serializeHtml).join('');
  }
  return html;
}
function serializeHtml(node) {
  if (!node) return '';
  if (node.nodeType === Node.DOCUMENT_NODE) {
    return Array.from(node.childNodes || []).map(serializeHtml).join('');
  }
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    return '<template shadowroot="open">' + Array.from(node.childNodes || []).map(serializeHtml).join('') + '</template>';
  }
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue || '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  var tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) || isHiddenElement(node)) return '';
  if (isNoisyCodeElement(node)) return '';
  if (tag === 'img' && String(node.getAttribute('src') || '').startsWith('data:image/')) return '';
  var html = '<' + tag + serializeAttributes(node);
  if (VOID_TAGS.has(tag)) return html + ' />';
  html += '>';
  if (node.shadowRoot) html += serializeHtml(node.shadowRoot);
  if ((tag === 'iframe' || tag === 'frame') && node.contentDocument) {
    try {
      html += Array.from(node.contentDocument.childNodes || []).map(serializeHtml).join('');
    } catch (_) {}
  } else if (tag === 'table') {
    html += serializeTableChildren(node);
  } else {
    html += Array.from(node.childNodes || []).map(serializeHtml).join('');
  }
  html += '</' + tag + '>';
  return html;
}
function markdownEscape(value) {
  return String(value || '').replace(/\\r/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
}
function markdownChildren(node, depth) {
  return Array.from(node.childNodes || []).map(function(child) { return markdownNode(child, depth); }).join('');
}
function markdownInline(node, depth) {
  return markdownEscape(markdownChildren(node, depth)).replace(/\\n+/g, ' ').trim();
}
function markdownList(node, depth, ordered) {
  var index = 1;
  return '\\n' + Array.from(node.children || []).map(function(child) {
    if (child.tagName && child.tagName.toLowerCase() === 'li') {
      var marker = ordered ? (index++) + '. ' : '- ';
      var inline = '';
      var nested = '';
      Array.from(child.childNodes || []).forEach(function(liChild) {
        if (liChild.nodeType === Node.ELEMENT_NODE && liChild.tagName && ['ul', 'ol'].includes(liChild.tagName.toLowerCase())) {
          nested += markdownNode(liChild, depth + 1);
        } else {
          inline += markdownNode(liChild, depth + 1);
        }
      });
      var line = '  '.repeat(depth) + marker + markdownEscape(inline).replace(/\\n+/g, ' ').trim();
      return line + '\\n' + nested.replace(/^\\n+/, '');
    }
    return markdownNode(child, depth);
  }).join('') + '\\n';
}
function markdownTable(node) {
  var rows = Array.from(node.querySelectorAll('tr')).map(function(row) {
    return Array.from(row.children || []).map(function(cell) { return compact(cell.textContent).split('|').join(String.fromCharCode(92) + '|'); });
  }).filter(function(row) { return row.length; });
  if (!rows.length) return '';
  var width = Math.max.apply(null, rows.map(function(row) { return row.length; }));
  var out = rows.map(function(row) {
    var cells = row.slice();
    while (cells.length < width) cells.push('');
    return '| ' + cells.join(' | ') + ' |';
  });
  if (out.length > 1) out.splice(1, 0, '| ' + Array(width).fill('---').join(' | ') + ' |');
  return '\\n' + out.join('\\n') + '\\n\\n';
}
function preprocessMarkdownContent(content) {
  var original = String(content || '');
  var cleaned = original
    .replace(new RegExp(String.fromCharCode(96) + '\\\\{["\\\\w][\\\\s\\\\S]*?\\\\}' + String.fromCharCode(96), 'g'), '')
    .replace(/\\{"\\$type":[^}]{100,}\\}/g, '')
    .replace(/\\{"[^"]{5,}":\\{[^}]{100,}\\}/g, '')
    .replace(/\\n{4,}/g, '\\n\\n\\n');
  cleaned = cleaned.split('\\n').filter(function(line) {
    var stripped = line.trim();
    if (!stripped) return false;
    if ((stripped[0] === '{' || stripped[0] === '[') && stripped.length > 100) {
      try {
        var parsed = JSON.parse(stripped);
        if (parsed !== null && typeof parsed === 'object') return false;
      } catch (e) {}
    }
    return true;
  }).join('\\n').trim();
  return {content: cleaned, filteredCharsRemoved: original.length - cleaned.length};
}
function markdownNode(node, depth) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
  if (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return markdownChildren(node, depth);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  var tag = node.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) || isHiddenElement(node)) return '';
  if (/^h[1-6]$/.test(tag)) {
    var heading = markdownInline(node, depth) || compact(node.textContent);
    return '\\n' + '#'.repeat(Number(tag[1])) + ' ' + heading + '\\n\\n';
  }
  if (tag === 'br') return '\\n';
  if (tag === 'pre') {
    var fence = String.fromCharCode(96).repeat(3);
    return '\\n' + fence + '\\n' + String(node.textContent || '').trim() + '\\n' + fence + '\\n\\n';
  }
  if (tag === 'code') {
    if (isNoisyCodeElement(node)) return '';
    var tick = String.fromCharCode(96);
    return tick + compact(node.textContent) + tick;
  }
  if (tag === 'strong' || tag === 'b') {
    var strong = markdownInline(node, depth);
    return strong ? '**' + strong + '**' : '';
  }
  if (tag === 'em' || tag === 'i') {
    var emphasis = markdownInline(node, depth);
    return emphasis ? '*' + emphasis + '*' : '';
  }
  if (tag === 'a') {
    var label = markdownInline(node, depth) || compact(node.textContent) || String(node.getAttribute('href') || '');
    var href = node.href || node.getAttribute('href') || '';
    return EXTRACT_LINKS && href ? '[' + label + '](' + href + ')' : label;
  }
  if (tag === 'img') {
    if (!EXTRACT_IMAGES) return compact(node.getAttribute('alt') || '');
    var alt = compact(node.getAttribute('alt') || 'image');
    var src = node.src || node.getAttribute('src') || '';
    return src && !src.startsWith('data:image/') ? '![' + alt + '](' + src + ')' : alt;
  }
  if (tag === 'ul' || tag === 'ol') return markdownList(node, depth, tag === 'ol');
  if (tag === 'table') return markdownTable(node);
  var body = markdownChildren(node, depth);
  if (['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav'].includes(tag)) {
    body = markdownEscape(body);
    return body ? body + '\\n\\n' : '';
  }
  return body;
}
try {
  var root = document.body || document.documentElement || document;
  var html = serializeHtml(document);
  var rawMarkdown = markdownEscape(markdownNode(root, 0));
  var markdownResult = preprocessMarkdownContent(rawMarkdown);
  var markdown = markdownResult.content;
  var text = compact(root.innerText || root.textContent || '');
  var content = redactSensitiveContent(FORMAT === 'html' ? html : FORMAT === 'text' ? text : markdown);
  return {
    ok: true,
    format: FORMAT,
    content: content,
    stats: {
      url: location.href,
      title: redactSensitiveContent(document.title || ''),
      htmlChars: html.length,
      markdownChars: markdown.length,
      filteredCharsRemoved: markdownResult.filteredCharsRemoved,
      textChars: text.length,
      contentChars: content.length,
      extractLinks: EXTRACT_LINKS,
      extractImages: EXTRACT_IMAGES
    }
  };
} catch (e) {
  return {ok: false, error: 'page content extraction error: ' + e.message, content: '', stats: {}};
}
})()`
}

const BLOCK_TYPES = {
  HEADER: 'header',
  CODE_FENCE: 'code_fence',
  TABLE: 'table',
  LIST_ITEM: 'list_item',
  PARAGRAPH: 'paragraph',
  BLANK: 'blank'
}
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)]) /
const LIST_CONTINUATION_RE = /^(\s{2,}|\t)/

function parseAtomicMarkdownBlocks(content) {
  const source = String(content || '')
  const lines = source.split('\n')
  const blocks = []
  let index = 0
  let offset = 0

  while (index < lines.length) {
    const line = lines[index]
    const lineLength = line.length + 1

    if (!line.trim()) {
      blocks.push({ blockType: BLOCK_TYPES.BLANK, lines: [line], charStart: offset, charEnd: offset + lineLength })
      offset += lineLength
      index += 1
      continue
    }

    if (line.trim().startsWith('```')) {
      const fenceLines = [line]
      let fenceEnd = offset + lineLength
      index += 1
      while (index < lines.length) {
        const fenceLine = lines[index]
        const fenceLineLength = fenceLine.length + 1
        fenceLines.push(fenceLine)
        fenceEnd += fenceLineLength
        index += 1
        if (fenceLine.trim().startsWith('```') && fenceLines.length > 1) break
      }
      blocks.push({ blockType: BLOCK_TYPES.CODE_FENCE, lines: fenceLines, charStart: offset, charEnd: fenceEnd })
      offset = fenceEnd
      continue
    }

    if (line.trimStart().startsWith('#')) {
      blocks.push({ blockType: BLOCK_TYPES.HEADER, lines: [line], charStart: offset, charEnd: offset + lineLength })
      offset += lineLength
      index += 1
      continue
    }

    if (TABLE_ROW_RE.test(line)) {
      const headerLines = [line]
      let headerEnd = offset + lineLength
      index += 1
      if (index < lines.length && TABLE_ROW_RE.test(lines[index]) && lines[index].includes('---')) {
        const separator = lines[index]
        const separatorLength = separator.length + 1
        headerLines.push(separator)
        headerEnd += separatorLength
        index += 1
      }
      blocks.push({ blockType: BLOCK_TYPES.TABLE, lines: headerLines, charStart: offset, charEnd: headerEnd })
      offset = headerEnd
      while (index < lines.length && TABLE_ROW_RE.test(lines[index])) {
        const row = lines[index]
        const rowLength = row.length + 1
        blocks.push({ blockType: BLOCK_TYPES.TABLE, lines: [row], charStart: offset, charEnd: offset + rowLength })
        offset += rowLength
        index += 1
      }
      continue
    }

    if (LIST_ITEM_RE.test(line)) {
      const listLines = [line]
      let listEnd = offset + lineLength
      index += 1
      while (index < lines.length) {
        const nextLine = lines[index]
        const nextLength = nextLine.length + 1
        if (LIST_ITEM_RE.test(nextLine)) {
          listLines.push(nextLine)
          listEnd += nextLength
          index += 1
          continue
        }
        if (nextLine.trim() && LIST_CONTINUATION_RE.test(nextLine)) {
          listLines.push(nextLine)
          listEnd += nextLength
          index += 1
          continue
        }
        break
      }
      blocks.push({ blockType: BLOCK_TYPES.LIST_ITEM, lines: listLines, charStart: offset, charEnd: listEnd })
      offset = listEnd
      continue
    }

    const paragraphLines = [line]
    let paragraphEnd = offset + lineLength
    index += 1
    while (index < lines.length && lines[index].trim()) {
      const nextLine = lines[index]
      if (
        nextLine.trimStart().startsWith('#') ||
        nextLine.trim().startsWith('```') ||
        TABLE_ROW_RE.test(nextLine) ||
        LIST_ITEM_RE.test(nextLine)
      ) {
        break
      }
      const nextLength = nextLine.length + 1
      paragraphLines.push(nextLine)
      paragraphEnd += nextLength
      index += 1
    }
    blocks.push({ blockType: BLOCK_TYPES.PARAGRAPH, lines: paragraphLines, charStart: offset, charEnd: paragraphEnd })
    offset = paragraphEnd
  }

  if (blocks.length && source && !source.endsWith('\n')) {
    const last = blocks[blocks.length - 1]
    blocks[blocks.length - 1] = { ...last, charEnd: source.length }
  }
  return blocks
}

function blockText(block) {
  if (typeof block?.content === 'string') return block.content
  return (block?.lines || []).join('\n')
}

function tableHeaderFor(block) {
  const lines = Array.isArray(block?.lines) ? block.lines : []
  if (block?.blockType !== BLOCK_TYPES.TABLE || lines.length < 2) return null
  const separatorLine = lines[1]
  if (separatorLine.includes('---') || separatorLine.includes('- -')) return `${lines[0]}\n${lines[1]}`
  return null
}

function safeMarkdownSplitEnd(source, start, requestedEnd, blockEnd) {
  let end = Math.max(start + 1, Math.min(blockEnd, requestedEnd))
  if (
    end < blockEnd &&
    /[\uD800-\uDBFF]/u.test(source[end - 1]) &&
    /[\uDC00-\uDFFF]/u.test(source[end])
  ) {
    // JavaScript cursors use UTF-16 code-unit offsets. Keep every cursor on a
    // valid character boundary even when maxChunkChars lands inside an astral
    // character.
    end = end - 1 > start ? end - 1 : Math.min(blockEnd, end + 1)
  }
  return end
}

function splitOversizedMarkdownBlock(block, source, limit) {
  const blockSize = block.charEnd - block.charStart
  if (blockSize <= limit) return [block]

  const fragments = []
  let fragmentStart = block.charStart
  while (fragmentStart < block.charEnd) {
    const fragmentEnd = safeMarkdownSplitEnd(
      source,
      fragmentStart,
      fragmentStart + limit,
      block.charEnd
    )
    fragments.push({
      ...block,
      content: source.slice(fragmentStart, fragmentEnd),
      lines: undefined,
      charStart: fragmentStart,
      charEnd: fragmentEnd,
      splitBlockStart: block.charStart,
      splitBlockEnd: block.charEnd
    })
    fragmentStart = fragmentEnd
  }
  return fragments
}

function chunkMarkdownByStructure(content, { maxChunkChars = 100000, overlapLines = 5, startFromChar = 0 } = {}) {
  const source = String(content || '')
  const limit = Math.max(1, Math.min(500000, Math.trunc(Number(maxChunkChars) || 100000)))
  const start = Math.max(0, Math.trunc(Number(startFromChar) || 0))
  const overlap = Math.max(0, Math.min(50, Math.trunc(Number(overlapLines) || 0)))

  if (!source) {
    return [{ content: '', chunkIndex: 0, totalChunks: 1, charOffsetStart: 0, charOffsetEnd: 0, overlapPrefix: '', hasMore: false }]
  }
  if (start >= source.length) return []

  const blocks = parseAtomicMarkdownBlocks(source)
    .flatMap(block => splitOversizedMarkdownBlock(block, source, limit))
  if (!blocks.length) return []

  const rawChunks = []
  let currentChunk = []
  let currentSize = 0
  for (const block of blocks) {
    const blockSize = block.charEnd - block.charStart
    if (currentSize + blockSize > limit && currentChunk.length) {
      let bestSplit = currentChunk.length
      for (let idx = currentChunk.length - 1; idx > 0; idx -= 1) {
        if (currentChunk[idx].blockType === BLOCK_TYPES.HEADER) {
          const prefixSize = currentChunk.slice(0, idx).reduce((total, item) => total + item.charEnd - item.charStart, 0)
          if (prefixSize >= limit * 0.5) {
            bestSplit = idx
            break
          }
        }
      }
      rawChunks.push(currentChunk.slice(0, bestSplit))
      currentChunk = currentChunk.slice(bestSplit)
      currentSize = currentChunk.reduce((total, item) => total + item.charEnd - item.charStart, 0)
    }
    currentChunk.push(block)
    currentSize += blockSize
  }
  if (currentChunk.length) rawChunks.push(currentChunk)

  const totalChunks = rawChunks.length
  const chunks = []
  let previousTableHeader = null
  for (let index = 0; index < rawChunks.length; index += 1) {
    const chunkBlocks = rawChunks[index]
    const charStart = chunkBlocks[0].charStart
    const charEnd = chunkBlocks[chunkBlocks.length - 1].charEnd
    // Cursor offsets address the original source, so preserve the exact
    // half-open source interval including structural delimiter newlines.
    const chunkText = source.slice(charStart, charEnd)
    let overlapPrefix = ''

    if (index > 0) {
      const previousBlocks = rawChunks[index - 1]
      const previousText = previousBlocks.map(blockText).join('\n')
      const previousLines = previousText.split('\n')
      const firstBlock = chunkBlocks[0]
      const previousLastBlock = previousBlocks[previousBlocks.length - 1]
      const continuesSplitBlock = (
        Number.isSafeInteger(firstBlock?.splitBlockStart) &&
        firstBlock.splitBlockStart === previousLastBlock?.splitBlockStart &&
        firstBlock.splitBlockEnd === previousLastBlock?.splitBlockEnd
      )
      if (continuesSplitBlock) {
        // A fragment of the same oversized source block already resumes
        // exactly at the previous cursor; repeated overlap would violate the
        // limit and duplicate source text.
        overlapPrefix = ''
      } else if (firstBlock.blockType === BLOCK_TYPES.TABLE && previousTableHeader) {
        const trailing = overlap > 0 ? previousLines.slice(-overlap) : []
        const combined = previousTableHeader.split('\n')
        for (const line of trailing) {
          if (!combined.includes(line)) combined.push(line)
        }
        overlapPrefix = combined.join('\n')
      } else if (overlap > 0) {
        overlapPrefix = previousLines.slice(-overlap).join('\n')
      }
    }

    for (const block of chunkBlocks) {
      const header = tableHeaderFor(block)
      if (header != null) previousTableHeader = header
    }

    chunks.push({
      content: chunkText,
      chunkIndex: index,
      totalChunks,
      charOffsetStart: charStart,
      charOffsetEnd: charEnd,
      overlapPrefix,
      hasMore: index < totalChunks - 1
    })
  }

  if (start <= 0) return chunks

  const remaining = chunks.filter(chunk => chunk.charOffsetEnd > start)
  if (!remaining.length || start <= remaining[0].charOffsetStart) return remaining

  // A host byte projection can leave the cursor inside an oversized Markdown
  // block. Resume from that exact source offset instead of repeating its
  // fragment prefix.
  remaining[0] = {
    ...remaining[0],
    content: source.slice(start, remaining[0].charOffsetEnd),
    charOffsetStart: start,
    overlapPrefix: ''
  }
  return remaining
}

function naiveChunkContent(content, { startFromChar = 0, maxChars = 100000 } = {}) {
  const source = String(content || '')
  const start = Math.max(0, Math.trunc(Number(startFromChar) || 0))
  const limit = Math.max(1, Math.min(500000, Math.trunc(Number(maxChars) || 100000)))
  if (start >= source.length) {
    return {
      content: '',
      startFromChar: start,
      maxChars: limit,
      contentLength: source.length,
      truncated: false,
      hasMore: false,
      nextStartChar: null,
      mainContentStart: 0
    }
  }
  let end = Math.min(source.length, start + limit)
  if (end < source.length) {
    const newline = source.lastIndexOf('\n', end)
    if (newline > start + Math.floor(limit * 0.6)) end = newline
  }
  return {
    content: source.slice(start, end).trim(),
    startFromChar: start,
    maxChars: limit,
    contentLength: source.length,
    truncated: end < source.length,
    hasMore: end < source.length,
    nextStartChar: end < source.length ? end : null,
    mainContentStart: 0
  }
}

function chunkContent(content, { startFromChar = 0, maxChars = 100000, format = 'markdown', overlapLines = 5 } = {}) {
  const source = String(content || '')
  if (coerceFormat(format) !== 'markdown') return naiveChunkContent(source, { startFromChar, maxChars })
  const start = Math.max(0, Math.trunc(Number(startFromChar) || 0))
  const limit = Math.max(1, Math.min(500000, Math.trunc(Number(maxChars) || 100000)))
  const chunks = chunkMarkdownByStructure(source, { maxChunkChars: limit, overlapLines, startFromChar: start })
  if (!chunks.length) {
    return {
      content: '',
      startFromChar: start,
      maxChars: limit,
      contentLength: source.length,
      truncated: false,
      hasMore: false,
      nextStartChar: null,
      chunkIndex: null,
      totalChunks: 0,
      charOffsetStart: null,
      charOffsetEnd: null,
      overlapPrefix: '',
      mainContentStart: 0
    }
  }
  const chunk = chunks[0]
  const contentWithOverlap = chunk.overlapPrefix ? `${chunk.overlapPrefix}\n${chunk.content}` : chunk.content
  const mainContentStart = chunk.overlapPrefix ? chunk.overlapPrefix.length + 1 : 0
  return {
    // Do not trim: the advertised source cursor span must match the returned
    // main content byte-for-byte at structural newlines.
    content: contentWithOverlap,
    startFromChar: start,
    maxChars: limit,
    contentLength: source.length,
    truncated: chunk.hasMore,
    hasMore: chunk.hasMore,
    nextStartChar: chunk.hasMore ? chunk.charOffsetEnd : null,
    chunkIndex: chunk.chunkIndex,
    totalChunks: chunk.totalChunks,
    charOffsetStart: chunk.charOffsetStart,
    charOffsetEnd: chunk.charOffsetEnd,
    overlapPrefix: chunk.overlapPrefix,
    mainContentStart
  }
}

// SHC-3:顶层 Node 版 markdown 后处理(与 buildPageContentExpression 沙箱串里的同名函数逐字等价,
// 正则反转义为单层),供 snapshot-service 的 Node 侧序列化器复用,避免两份实现漂移。
function preprocessMarkdownContent(content) {
  const original = String(content || '')
  let cleaned = original
    .replace(/`\{["\w][\s\S]*?\}`/g, '')
    .replace(/\{"\$type":[^}]{100,}\}/g, '')
    .replace(/\{"[^"]{5,}":\{[^}]{100,}\}/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
  cleaned = cleaned.split('\n').filter(line => {
    const stripped = line.trim()
    if (!stripped) return false
    if ((stripped[0] === '{' || stripped[0] === '[') && stripped.length > 100) {
      try {
        const parsed = JSON.parse(stripped)
        if (parsed !== null && typeof parsed === 'object') return false
      } catch {
        // Non-JSON long lines are ordinary page content, so keep them.
      }
    }
    return true
  }).join('\n').trim()
  return { content: cleaned, filteredCharsRemoved: original.length - cleaned.length }
}

module.exports = { buildPageContentExpression, chunkContent, chunkMarkdownByStructure, coerceFormat, preprocessMarkdownContent }
