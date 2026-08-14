// 键码逻辑逐字
//   actor/utils.py get_key_info(权威 code + windowsVirtualKeyCode 表)
//   default_action_watchdog.py send_keys / _get_char_modifiers_and_vk / _get_key_code_for_char
// KEY_INFO[name] = [code, windowsVirtualKeyCode]
const KEY_INFO = {
  Backspace: ['Backspace', 8], Tab: ['Tab', 9], Enter: ['Enter', 13], Escape: ['Escape', 27],
  Space: ['Space', 32], ' ': ['Space', 32],
  PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], End: ['End', 35], Home: ['Home', 36],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Insert: ['Insert', 45], Delete: ['Delete', 46],
  // 修饰键:code 带 Left、VK 为标准 16/17/18/91(SK-2)
  Shift: ['ShiftLeft', 16], ShiftLeft: ['ShiftLeft', 16], ShiftRight: ['ShiftRight', 16],
  Control: ['ControlLeft', 17], ControlLeft: ['ControlLeft', 17], ControlRight: ['ControlRight', 17],
  Alt: ['AltLeft', 18], AltLeft: ['AltLeft', 18], AltRight: ['AltRight', 18],
  Meta: ['MetaLeft', 91], MetaLeft: ['MetaLeft', 91], MetaRight: ['MetaRight', 92],
  // 功能键 VK 112–135(SK-3)
  F1: ['F1', 112], F2: ['F2', 113], F3: ['F3', 114], F4: ['F4', 115], F5: ['F5', 116], F6: ['F6', 117],
  F7: ['F7', 118], F8: ['F8', 119], F9: ['F9', 120], F10: ['F10', 121], F11: ['F11', 122], F12: ['F12', 123],
  F13: ['F13', 124], F14: ['F14', 125], F15: ['F15', 126], F16: ['F16', 127], F17: ['F17', 128], F18: ['F18', 129],
  F19: ['F19', 130], F20: ['F20', 131], F21: ['F21', 132], F22: ['F22', 133], F23: ['F23', 134], F24: ['F24', 135],
  NumLock: ['NumLock', 144], CapsLock: ['CapsLock', 20], ScrollLock: ['ScrollLock', 145],
  Numpad0: ['Numpad0', 96], Numpad1: ['Numpad1', 97], Numpad2: ['Numpad2', 98], Numpad3: ['Numpad3', 99],
  Numpad4: ['Numpad4', 100], Numpad5: ['Numpad5', 101], Numpad6: ['Numpad6', 102], Numpad7: ['Numpad7', 103],
  Numpad8: ['Numpad8', 104], Numpad9: ['Numpad9', 105], NumpadMultiply: ['NumpadMultiply', 106],
  NumpadAdd: ['NumpadAdd', 107], NumpadSubtract: ['NumpadSubtract', 109], NumpadDecimal: ['NumpadDecimal', 110],
  NumpadDivide: ['NumpadDivide', 111],
  // OEM / 标点 VK(SK-4):code 名 + Windows VK
  Semicolon: ['Semicolon', 186], ';': ['Semicolon', 186], Equal: ['Equal', 187], '=': ['Equal', 187],
  Comma: ['Comma', 188], ',': ['Comma', 188], Minus: ['Minus', 189], '-': ['Minus', 189],
  Period: ['Period', 190], '.': ['Period', 190], Slash: ['Slash', 191], '/': ['Slash', 191],
  Backquote: ['Backquote', 192], '`': ['Backquote', 192], BracketLeft: ['BracketLeft', 219], '[': ['BracketLeft', 219],
  Backslash: ['Backslash', 220], '\\': ['Backslash', 220], BracketRight: ['BracketRight', 221], ']': ['BracketRight', 221],
  Quote: ['Quote', 222], "'": ['Quote', 222],
  Clear: ['Clear', 12], Pause: ['Pause', 19], Select: ['Select', 41], Print: ['Print', 42]
}

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

// 小写别名 → 规范名(SK-1:补全 enter/tab/escape/backspace 等;原先缺这些导致被当文本逐字打出)
const ALIASES = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  space: ' ', spacebar: ' ',
  arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown',
  arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
  ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta',
  capslock: 'CapsLock', numlock: 'NumLock', scrolllock: 'ScrollLock',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12'
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function normalizeKey(key) {
  const raw = key == null ? '' : String(key)
  // A literal ASCII space is a real key/text character. Preserve that exact
  // spelling, but keep rejecting empty or otherwise whitespace-only payloads
  // so accidental indentation/newlines are not interpreted as a key.
  if (raw === ' ') return ' '
  const value = raw.trim()
  if (!value) throw new Error('key is required')
  const lower = value.toLowerCase()
  if (ALIASES[lower]) return ALIASES[lower]
  if (KEY_INFO[value]) return value          // 已是规范名(Enter/ArrowUp/Control/'-' …)
  const upper = value.toUpperCase()
  if (KEY_INFO[upper]) return upper           // F1.. / 大小写规范化
  return value                                // 单字符或未知,原样
}

// 返回 combo 的有序修饰键名(保留输入次序,SK-7)+ base 键 + bitmask
function normalizeCombo(raw) {
  const parts = String(raw ?? '').split('+').map(part => normalizeKey(part))
  if (!parts.length) throw new Error('key is required')
  const base = parts.pop()
  const modifierNames = []
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIER_BITS[part]
    if (bit) { modifiers |= bit; modifierNames.push(part) }
  }
  return { key: base, modifiers, modifierNames }
}

const SPECIAL_KEYS = new Set(Object.keys(KEY_INFO).filter(k => k.length > 1 && !/^[;=,\-./`[\\\]']$/.test(k)))

function keyMode(key) {
  const combo = normalizeCombo(key)
  if (combo.modifiers) return 'combo'
  if (SPECIAL_KEYS.has(combo.key)) return 'special'
  return 'text'
}

function codeFor(key) {
  if (KEY_INFO[key]) return KEY_INFO[key][0]
  if (key.length === 1 && /[a-z]/i.test(key)) return `Key${key.toUpperCase()}`
  if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`
  if (key === ' ') return 'Space'
  return key
}

function vkFor(key) {
  if (KEY_INFO[key]) return KEY_INFO[key][1]
  if (key.length === 1) return key.toUpperCase().charCodeAt(0)
  return 0
}

function keyEventParams(type, key, modifiers = 0) {
  const virtualKeyCode = vkFor(key)
  const params = {
    type,
    key,
    code: codeFor(key),
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  }
  if (modifiers) params.modifiers = modifiers
  return params
}

function editingCommandsForCombo(key, modifiers) {
  if (
    (modifiers === MODIFIER_BITS.Control || modifiers === MODIFIER_BITS.Meta) &&
    String(key).toLowerCase() === 'a'
  ) {
    return ['selectAll']
  }
  return null
}

// 单个字符 → keyDown 事件参数(对齐 BU _get_char_modifiers_and_vk / _get_key_code_for_char)
function keyInfoForChar(char) {
  if (char === ' ') return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 0 }
  const shifted = {
    '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
    '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'",
    '<': ',', '>': '.', '?': '/'
  }
  const isUpper = /[A-Z]/.test(char) && char.toLowerCase() !== char
  const base = shifted[char] || (isUpper ? char.toLowerCase() : char)
  const modifiers = (shifted[char] || isUpper) ? MODIFIER_BITS.Shift : 0
  if (/[a-z]/.test(base)) {
    // 字母:key 用小写 base(SK-8,BU 对 'A' 发 key:'a'+Shift);vk = 大写 ASCII
    return { key: base, code: `Key${base.toUpperCase()}`, windowsVirtualKeyCode: base.toUpperCase().charCodeAt(0), modifiers }
  }
  if (/[0-9]/.test(base)) {
    return { key: base, code: `Digit${base}`, windowsVirtualKeyCode: base.charCodeAt(0), modifiers }
  }
  if (KEY_INFO[base]) {
    // 标点:code + VK 取自权威表(SK-4,189/187/186… 而非 ASCII)
    return { key: base, code: KEY_INFO[base][0], windowsVirtualKeyCode: KEY_INFO[base][1], modifiers }
  }
  // 非 ASCII / CJK:code='Key{大写}'(SK-9,'中'→'Key中'),vk 用 0(无 Windows VK)
  return { key: base, code: /[a-z]/i.test(base) ? `Key${base.toUpperCase()}` : `Key${base}`, windowsVirtualKeyCode: 0, modifiers }
}

async function dispatchKeyEvent(client, type, key, sessionId = undefined, modifiers = 0) {
  await client.send('Input.dispatchKeyEvent', keyEventParams(type, key, modifiers), sessionId)
}

async function sendTextCharacter(client, char, sessionId = undefined) {
  if (char === '\n' || char === '\r') {
    // 换行/回车统一用 keyDown(key:'Enter',code:'Enter',VK13)→ char text='\r' → keyUp,
    // 与 runtime._dispatchTextCharacter 和 _impl 一致(INPUT-3,消除 rawKeyDown 两套风格)。
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' }, sessionId)
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId)
    return
  }
  const info = keyInfoForChar(char)
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: info.key, code: info.code, modifiers: info.modifiers, windowsVirtualKeyCode: info.windowsVirtualKeyCode }, sessionId)
  await client.send('Input.dispatchKeyEvent', { type: 'char', text: char, key: char }, sessionId)
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: info.key, code: info.code, modifiers: info.modifiers, windowsVirtualKeyCode: info.windowsVirtualKeyCode }, sessionId)
}

async function sendKey(client, key, sessionId = undefined) {
  const raw = String(key || '')
  const combo = normalizeCombo(raw)
  if (combo.modifiers) {
    const commands = editingCommandsForCombo(combo.key, combo.modifiers)
    if (commands) {
      // Chromium does not reliably turn a synthetic modifier-down sequence
      // into an editing shortcut inside contenteditable iframe documents.
      // Send the base key as one native editing command, matching both
      // browser-harness' raw select-all path and ego-lite's explicit command.
      await client.send('Input.dispatchKeyEvent', {
        ...keyEventParams('rawKeyDown', combo.key, combo.modifiers),
        commands
      }, sessionId)
      await client.send(
        'Input.dispatchKeyEvent',
        keyEventParams('keyUp', combo.key, combo.modifiers),
        sessionId
      )
      return { mode: 'combo', key: raw, events: 2 }
    }
    const modifierNames = combo.modifierNames        // 保留输入次序(SK-7)
    for (const modifier of modifierNames) await dispatchKeyEvent(client, 'keyDown', modifier, sessionId)
    await dispatchKeyEvent(client, 'keyDown', combo.key, sessionId, combo.modifiers)
    await dispatchKeyEvent(client, 'keyUp', combo.key, sessionId, combo.modifiers)
    for (const modifier of [...modifierNames].reverse()) await dispatchKeyEvent(client, 'keyUp', modifier, sessionId)
    return { mode: 'combo', key: raw, events: modifierNames.length * 2 + 2 }
  }

  if (SPECIAL_KEYS.has(combo.key)) {
    await dispatchKeyEvent(client, 'keyDown', combo.key, sessionId)
    let events = 2
    if (combo.key === 'Enter') {
      await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' }, sessionId)
      events += 1
    }
    await dispatchKeyEvent(client, 'keyUp', combo.key, sessionId)
    return { mode: 'special', key: raw, events }
  }

  let events = 0
  for (const char of raw) {
    await sendTextCharacter(client, char, sessionId)
    events += 3
    await sleep(10)                                  // 字符间 10ms 节流(SK-5,对齐 BU)
  }
  return { mode: 'text', key: raw, events }
}

module.exports = { sendKey, normalizeCombo, keyInfoForChar, keyMode }
