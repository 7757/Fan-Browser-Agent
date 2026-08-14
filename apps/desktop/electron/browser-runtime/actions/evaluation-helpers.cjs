function stringifyEvaluateValue(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return Array.isArray(value) || (value && typeof value === 'object') ? JSON.stringify(value) : String(value)
  } catch {
    return String(value)
  }
}

function fixJavascriptString(jsCode) {
  let value = String(jsCode || '').trim()
  if (!value) throw new Error('JavaScript code is empty after cleaning')
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1)
    if (inner.split('"').length + inner.split("'").length - 2 === 0 || inner.includes('() =>')) {
      value = inner
    }
  }
  const escapedDouble = (value.match(/\\"/g) || []).length
  const rawDouble = (value.match(/"/g) || []).length
  if (escapedDouble > 0 && escapedDouble > rawDouble) value = value.replace(/\\"/g, '"')
  const escapedSingle = (value.match(/\\'/g) || []).length
  const rawSingle = (value.match(/'/g) || []).length
  if (escapedSingle > 0 && escapedSingle > rawSingle) value = value.replace(/\\'/g, "'")
  value = value.trim()
  if (!value) throw new Error('JavaScript code is empty after cleaning')
  return value
}

function validateAndFixJavaScript(code) {
  let fixed = String(code || '')
  fixed = fixed.replace(/\\"/g, '"')
  fixed = fixed.replace(/\\\\([dDsSwWbBnrtfv])/g, (_, char) => `\\${char}`)
  fixed = fixed.replace(/\\\\([.*+?^${}()|[\]\\])/g, (_, char) => `\\${char}`)
  fixed = fixed.replace(/document\.evaluate\s*\(\s*"([^"]*)"\s*,/g, (_, xpath) => `document.evaluate(\`${xpath}\`,`)
  fixed = fixed.replace(/(querySelector(?:All)?)\s*\(\s*"([^"]*)"\s*\)/g, (_, method, selector) => `${method}(\`${selector}\`)`)
  fixed = fixed.replace(/\.closest\s*\(\s*"([^"]*)"\s*\)/g, (_, selector) => `.closest(\`${selector}\`)`)
  fixed = fixed.replace(/\.matches\s*\(\s*"([^"]*)"\s*\)/g, (_, selector) => `.matches(\`${selector}\`)`)
  return fixed
}

function formatJavaScriptEvaluationResult(resultData = {}, maxChars = 20000) {
  let value
  let text
  if (Object.prototype.hasOwnProperty.call(resultData, 'value')) {
    value = resultData.value
    if (value == null) {
      text = String(value)
    } else if (Array.isArray(value) || typeof value === 'object') {
      try {
        text = JSON.stringify(value)
      } catch {
        text = String(value)
      }
    } else {
      text = String(value)
    }
  } else {
    value = undefined
    text = 'undefined'
  }
  const images = []
  text = String(text || '').replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, match => {
    images.push(match)
    return '[Image]'
  })
  const limit = Math.max(1000, Number(maxChars) || 20000)
  let truncated = false
  if (text.length > limit) {
    const head = Math.max(0, limit - 50)
    text = `${text.slice(0, head)}\n... [Truncated after ${limit} characters]`
    truncated = true
  }
  return { value, text, images, truncated }
}

function elementFunctionDeclaration(expression) {
  const pageFunction = String(expression || '').trim()
  if (!(pageFunction.includes('=>') && (pageFunction.startsWith('(') || pageFunction.startsWith('async')))) {
    throw new Error('expression must start with (...args) => or async (...args) =>')
  }
  const isAsync = pageFunction.startsWith('async')
  const source = isAsync ? pageFunction.slice(5).trim() : pageFunction
  const match = source.match(/^\(([^)]*)\)\s*=>\s*([\s\S]+)$/)
  if (!match) throw new Error('Could not parse element arrow function')
  const params = match[1].trim()
  const body = match[2].trim()
  const prefix = isAsync ? 'async ' : ''
  if (!body.startsWith('{')) return `${prefix}function(${params}) { return ${body}; }`
  return `${prefix}function(${params}) ${body}`
}

module.exports = {
  elementFunctionDeclaration,
  fixJavascriptString,
  formatJavaScriptEvaluationResult,
  stringifyEvaluateValue,
  validateAndFixJavaScript
}
