const OVERLAY_DETECTION_SOURCE = String.raw`
    function detectOverlay() {
      const viewportWidth = Math.max(1, Number(window.innerWidth) || 1);
      const viewportHeight = Math.max(1, Number(window.innerHeight) || 1);
      const viewportArea = viewportWidth * viewportHeight;
      const bodyStyle = document.body ? window.getComputedStyle(document.body) : null;
      const htmlStyle = document.documentElement
        ? window.getComputedStyle(document.documentElement)
        : null;
      const bodyScrollLocked = Boolean(
        (bodyStyle && (
          bodyStyle.overflow === 'hidden' ||
          bodyStyle.overflowY === 'hidden' ||
          bodyStyle.position === 'fixed'
        )) ||
        (htmlStyle && (
          htmlStyle.overflow === 'hidden' ||
          htmlStyle.overflowY === 'hidden'
        ))
      );
      const compactOverlayText = (value, max = 160) =>
        String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
      const visibleOverlayNode = element => {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        const style = window.getComputedStyle(element);
        if (!style || style.pointerEvents === 'none') return false;
        let opacity = 1;
        let cursor = element;
        while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
          const cursorStyle = window.getComputedStyle(cursor);
          if (
            !cursorStyle ||
            cursorStyle.display === 'none' ||
            cursorStyle.visibility === 'hidden' ||
            cursor.hidden === true ||
            cursor.inert === true ||
            cursor.getAttribute('aria-hidden') === 'true'
          ) return false;
          const ownOpacity = Number(cursorStyle.opacity);
          if (Number.isFinite(ownOpacity)) opacity *= ownOpacity;
          cursor = cursor.parentElement;
        }
        if (opacity <= 0.05) return false;
        const rect = element.getBoundingClientRect();
        return Boolean(
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < viewportHeight &&
          rect.left < viewportWidth
        );
      };
      const actionLabel = element => compactOverlayText(
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.innerText ||
        element.textContent ||
        element.getAttribute('data-action') ||
        ''
      );
      const closePattern = /^(?:close|dismiss|skip|later|not now|no thanks|got it|×|✕|关闭|关 闭|跳过|稍后|以后再说|暂不|知道了|我知道了)$/i;
      const closeHintPattern = /(?:^|[-_\s])(?:close|dismiss|skip|later)(?:$|[-_\s])/i;
      const closeCandidatesFor = root => {
        const actions = Array.from(root.querySelectorAll(
          'button,[role="button"],a[href],[tabindex]:not([tabindex="-1"]),[aria-label],[title]'
        )).slice(0, 300);
        const closeCandidates = [];
        for (const action of actions) {
          if (!visibleOverlayNode(action)) continue;
          const label = actionLabel(action);
          const hint = [
            action.id,
            typeof action.className === 'string' ? action.className : '',
            action.getAttribute('data-action'),
            action.getAttribute('data-testid')
          ].filter(Boolean).join(' ');
          const hintOnlyClose = !label && closeHintPattern.test(hint);
          if (!closePattern.test(label) && !hintOnlyClose) continue;
          const rect = action.getBoundingClientRect();
          closeCandidates.push({
            tag: String(action.tagName || '').toLowerCase(),
            id: compactOverlayText(action.id, 120),
            label,
            rect: {
              x: rect.left + (window.scrollX || 0),
              y: rect.top + (window.scrollY || 0),
              width: rect.width,
              height: rect.height
            }
          });
          if (closeCandidates.length >= 8) break;
        }
        return closeCandidates;
      };

      const candidates = new Set();
      for (const element of document.querySelectorAll(
        'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],' +
        '[class*="modal" i],[class*="overlay" i],[class*="dialog" i],' +
        '[class*="drawer" i],[class*="popup" i],[data-state="open"]'
      )) {
        candidates.add(element);
      }
      for (const element of Array.from(document.body?.children || []).slice(0, 200)) {
        candidates.add(element);
      }

      let best = null;
      for (const element of candidates) {
        if (!visibleOverlayNode(element)) continue;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const clippedWidth = Math.max(0, Math.min(viewportWidth, rect.right) - Math.max(0, rect.left));
        const clippedHeight = Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top));
        const coverage = (clippedWidth * clippedHeight) / viewportArea;
        const role = String(element.getAttribute('role') || '').toLowerCase();
        const semantic = (
          role === 'dialog' ||
          role === 'alertdialog' ||
          element.getAttribute('aria-modal') === 'true' ||
          (String(element.tagName || '').toLowerCase() === 'dialog' && element.open)
        );
        const classHint = /modal|overlay|dialog|drawer|popup/i.test(
          String(element.id || '') + ' ' +
          (typeof element.className === 'string' ? element.className : '')
        );
        const position = String(style.position || '').toLowerCase();
        const zIndex = Number.parseInt(style.zIndex, 10);
        const positioned = position === 'fixed' || position === 'absolute';
        if (
          !semantic &&
          !(
            positioned &&
            coverage >= 0.18 &&
            (bodyScrollLocked || classHint || (Number.isFinite(zIndex) && zIndex >= 10))
          )
        ) continue;

        const closeCandidates = closeCandidatesFor(element);
        const score =
          (semantic ? 1000000 : 0) +
          (closeCandidates.length ? 100000 : 0) +
          (bodyScrollLocked ? 10000 : 0) +
          Math.round(coverage * 1000) +
          (Number.isFinite(zIndex) ? Math.max(0, Math.min(zIndex, 9999)) : 0);
        if (best && best.score >= score) continue;
        best = {
          score,
          semantic,
          bodyScrollLocked,
          occludesMainContent: coverage >= 0.3,
          coverage,
          role,
          name: compactOverlayText(
            element.getAttribute('aria-label') ||
            element.getAttribute('title') ||
            element.querySelector('h1,h2,h3,[role="heading"]')?.textContent ||
            ''
          ),
          zIndex: Number.isFinite(zIndex) ? zIndex : null,
          closeCandidates
        };
      }

      if (!best) return null;
      delete best.score;
      return best;
    }
`

function buildObserveExpression({ maxElements = 300, publishSelectorMap = true } = {}) {
  // 删 cap:不再 clamp 到 1000(对齐 无元素数上限);仅尊重显式正整数,否则不限量。
  const limit = Number(maxElements) > 0 ? Number(maxElements) : Number.MAX_SAFE_INTEGER
  return `(() => {
    const MAX_ELEMENTS = ${JSON.stringify(limit)};
    const PASSWORD_VALUE_MARKER = '[password-populated]';
    const PASSWORD_VALUE_ATTRIBUTES = new Set([
      'value', 'valuetext', 'valuenow', 'aria-valuetext', 'aria-valuenow'
    ]);
    const passwordStates = new WeakMap();
    const pageSensitiveValues = new Set();
    ${OVERLAY_DETECTION_SOURCE}
    const interactiveSelector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      'option',
      'summary',
      'details',
      'label',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="combobox"]',
      '[role="textbox"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="tab"]',
      '[role="slider"]',
      '[role="spinbutton"]',
      '[role="search"]',
      '[role="searchbox"]',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[contenteditable="plaintext-only"]',
      '[tabindex]:not([tabindex="-1"])',
      '[onclick]',
      '[onmousedown]',
      '[onmouseup]',
      '[onkeydown]',
      '[data-action]',
      '[aria-expanded]',
      '[aria-pressed]',
      '[aria-checked]',
      '[aria-selected]'
    ].join(',');

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => '\\\\' + ch);
    }

    function selectorFor(el, boundaryRoot) {
      const root = boundaryRoot || el.getRootNode();
      const passwordState = passwordStateFor(el);
      if (el.id && !passwordState.sensitiveValues.has(String(el.id))) {
        const idSelector = '#' + cssEscape(el.id);
        try {
          // Duplicate ids are invalid HTML but common in generated pages. A
          // bare id is safe only when it identifies this one node in its root.
          if (root.querySelectorAll(idSelector).length === 1) return idSelector;
        } catch {}
      }
      const testAttrs = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'title', 'placeholder'];
      for (const attr of testAttrs) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (!value || String(value).length > 120) continue;
        if (passwordState.sensitiveValues.has(String(value))) continue;
        const selector = el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(String(value)) + ']';
        try {
          if (root.querySelectorAll(selector).length === 1) return selector;
        } catch {}
      }
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement && node !== root) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
          if (siblings.length > 1) {
            part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.length ? parts.join(' > ') : el.tagName.toLowerCase();
    }

    function compact(value, max = 240) {
      return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    }

    function isPasswordInput(el) {
      return Boolean(
        el &&
        el.tagName &&
        el.tagName.toLowerCase() === 'input' &&
        String(el.getAttribute && el.getAttribute('type') || '').trim().toLowerCase() === 'password'
      );
    }

    function passwordStateFor(el) {
      if (!isPasswordInput(el)) return { populated: false, sensitiveValues: new Set() };
      const cached = passwordStates.get(el);
      if (cached) return cached;
      const sensitiveValues = new Set();
      for (const name of PASSWORD_VALUE_ATTRIBUTES) {
        const value = el.getAttribute && el.getAttribute(name);
        if (value != null && String(value) !== '' && String(value) !== PASSWORD_VALUE_MARKER) {
          sensitiveValues.add(String(value));
        }
      }
      const hasLiveValue = typeof el.value === 'string';
      if (hasLiveValue && el.value !== '' && el.value !== PASSWORD_VALUE_MARKER) {
        sensitiveValues.add(String(el.value));
      }
      for (const value of sensitiveValues) pageSensitiveValues.add(value);
      const state = {
        // The live property is authoritative even when it is empty. Static
        // value attributes can retain an old default after the user clears.
        populated: hasLiveValue
          ? el.value !== ''
          : Array.from(sensitiveValues).some(value => value !== ''),
        sensitiveValues
      };
      passwordStates.set(el, state);
      return state;
    }

    function redactPasswordValue(el, value) {
      if (value == null || !isPasswordInput(el)) return value;
      return passwordStateFor(el).sensitiveValues.has(String(value))
        ? PASSWORD_VALUE_MARKER
        : value;
    }

    function redactPageText(value) {
      let output = String(value || '');
      for (const sensitiveValue of pageSensitiveValues) {
        if (!sensitiveValue) continue;
        if (output === sensitiveValue) return PASSWORD_VALUE_MARKER;
        if (sensitiveValue.length >= 3) output = output.split(sensitiveValue).join(PASSWORD_VALUE_MARKER);
      }
      return output;
    }

    function passwordValuePopulated(el) {
      return passwordStateFor(el).populated;
    }

    function textFor(el) {
      const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelRoot = el.getRootNode && el.getRootNode();
        const labelText = labelledBy.split(/\\s+/)
          .map(id => (labelRoot && typeof labelRoot.getElementById === 'function' ? labelRoot.getElementById(id) : null) || el.ownerDocument.getElementById(id))
          .filter(Boolean)
          .map(node => compact(node.innerText || node.textContent))
          .filter(Boolean)
          .join(' ');
        if (labelText) return compact(redactPasswordValue(el, labelText));
      }
      if (el.labels && el.labels.length) {
        const labelText = Array.from(el.labels).map(label => compact(label.innerText || label.textContent)).filter(Boolean).join(' ');
        if (labelText) return compact(redactPasswordValue(el, labelText));
      }
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const type = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase();
      if (tag === 'select') {
        const selected = Array.from(el.selectedOptions || []).map(opt => compact(opt.textContent)).filter(Boolean).join(', ');
        if (selected) return selected;
      }
      if (isPasswordInput(el)) {
        for (const attr of ['aria-label', 'placeholder', 'title', 'alt', 'name']) {
          const value = el.getAttribute && el.getAttribute(attr);
          if (value && String(value).trim()) return compact(redactPasswordValue(el, value));
        }
        return passwordValuePopulated(el) ? PASSWORD_VALUE_MARKER : '';
      }
      if ((tag === 'input' || tag === 'textarea') && typeof el.value === 'string' && el.value.trim()) {
        return compact(el.value);
      }
      const attrs = ['aria-label', 'placeholder', 'title', 'alt', 'value', 'name'];
      for (const attr of attrs) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (value && String(value).trim()) return compact(value);
      }
      return compact(el.innerText || el.textContent || '');
    }

    function isVisible(el) {
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      if (!view) return false;
      const style = view.getComputedStyle(el);
      if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > view.innerHeight || rect.left > view.innerWidth) return false;
      return true;
    }

    function hasFormControlDescendant(el, depth = 2) {
      if (!el || depth <= 0) return false;
      for (const child of Array.from(el.children || [])) {
        if (child.matches && child.matches('input,select,textarea')) return true;
        if (hasFormControlDescendant(child, depth - 1)) return true;
      }
      return false;
    }

    function normalizedRole(el) {
      return String(el.getAttribute && el.getAttribute('role') || '').toLowerCase();
    }

    function isDisabled(el) {
      if (!el) return false;
      if (el.disabled) return true;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
      if (el.hasAttribute && el.hasAttribute('inert')) return true;
      if (el.hasAttribute && el.hasAttribute('data-disabled')) {
        const value = String(el.getAttribute('data-disabled') || '').toLowerCase();
        if (!value || value === 'true') return true;
      }
      const disabledClasses = new Set([
        'disabled', 'is-disabled', 'is_disabled', 'unavailable',
        'ui-state-disabled', 'ui-datepicker-unselectable',
        'ant-picker-cell-disabled', 'mui-disabled', 'flatpickr-disabled',
        'react-datepicker__day--disabled'
      ]);
      const classNames = String(el.getAttribute && el.getAttribute('class') || '')
        .toLowerCase().split(/\\s+/).filter(Boolean);
      if (classNames.some(name => disabledClasses.has(name) || /(?:^|[-_])disabled(?:$|[-_])/.test(name))) return true;
      const fieldset = el.closest && el.closest('fieldset[disabled]');
      if (fieldset) return true;
      const inertAncestor = el.closest && el.closest('[inert]');
      return Boolean(inertAncestor);
    }

    function isReadonly(el) {
      if (!el) return false;
      if (el.readOnly === true) return true;
      if (el.hasAttribute && el.hasAttribute('readonly')) return true;
      if (el.getAttribute && el.getAttribute('aria-readonly') === 'true') return true;
      if (el.getAttribute && el.getAttribute('contenteditable') === 'false') return true;
      return false;
    }

    function isTypeable(el) {
      if (isReadonly(el)) return false;
      const tag = el.tagName.toLowerCase();
      const type = String(el.getAttribute('type') || '').toLowerCase();
      if (tag === 'textarea') return true;
      if (el.isContentEditable) return true;
      if (normalizedRole(el) === 'textbox' || normalizedRole(el) === 'searchbox') return true;
      if (tag !== 'input') return false;
      return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
    }

    function isClickable(el) {
      if (isDisabled(el)) return false;
      const tag = el.tagName.toLowerCase();
      const role = normalizedRole(el);
      if (['button', 'a', 'summary', 'details', 'option'].includes(tag)) return true;
      if (tag === 'input') return true;
      if (tag === 'label' && !el.getAttribute('for') && hasFormControlDescendant(el)) return true;
      if (tag === 'span' && hasFormControlDescendant(el)) return true;
      if (['button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab', 'combobox', 'slider', 'spinbutton'].includes(role)) return true;
      if (el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.hasAttribute('onmouseup')) return true;
      if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked') || el.hasAttribute('aria-selected')) return true;
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (style && style.cursor === 'pointer') return true;
      const haystack = [
        el.id,
        el.className,
        el.getAttribute('data-action'),
        el.getAttribute('data-testid'),
        el.getAttribute('aria-label')
      ].join(' ').toLowerCase();
      return /search|magnify|lookup|find|query|submit|next|prev|close|open|menu/.test(haystack);
    }

    function isScrollable(el) {
      return Number(el.scrollHeight || 0) > Number(el.clientHeight || 0) + 2 ||
        Number(el.scrollWidth || 0) > Number(el.clientWidth || 0) + 2;
    }

    function isInteractive(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      // SVG 子图元(circle/path/rect/g/…)永不独立成元素:它们只是图标的矢量笔画,
      // 却继承父级的 cursor:pointer 而看似可点(isClickable:163),在密集 icon 区
      // 制造成团的假目标(真机 bug:发送键旁 1288-1313 全是图元,视觉选中 4×4px 的
      // <circle> 1312 → 点击必失败)。可操作对象是 <svg> 根或其 HTML 祖先。
      // ownerSVGElement 恰好只对 SVG 后代非空(<svg> 根自身与 HTML 元素均为 null)。
      if (el.ownerSVGElement) return false;
      const tag = el.tagName.toLowerCase();
      if (['html', 'body', 'head', 'meta', 'link', 'style', 'script', 'title'].includes(tag)) return false;
      if (isDisabled(el)) return true;
      if (tag === 'select' || tag === 'textarea') return true;
      if (isTypeable(el)) return true;
      if (isClickable(el)) return true;
      if (tag === 'iframe' || tag === 'frame') {
        const rect = el.getBoundingClientRect();
        return rect.width > 100 && rect.height > 100;
      }
      if (isScrollable(el)) return true;
      return false;
    }

    // 只认强可交互信号(真交互标签 / ARIA role / 原生事件属性 / 可输入)。不含 cursor:pointer /
    // class 正则 / 可滚动这类弱信号——否则大容器(如 span.ci-submit-button 因 class 含 'submit'、
    // 或 div 因 cursor:pointer)会被当作可交互祖先、把里面精确的图标控件吞掉(null-ancestor-inpage-5)。
    function isStrongInteractive(el) {
      const tag = el.tagName.toLowerCase();
      if (['button', 'a', 'summary', 'details', 'option', 'select', 'textarea', 'input'].includes(tag)) return true;
      if (isTypeable(el)) return true;
      const role = normalizedRole(el);
      if (['button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab', 'combobox', 'slider', 'spinbutton'].includes(role)) return true;
      return el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.hasAttribute('onmouseup');
    }

    function hasInteractiveAncestor(el, root) {
      const controlTags = new Set(['input', 'select', 'textarea', 'option']);
      if (controlTags.has(el.tagName.toLowerCase())) return false;
      let parent = el.parentElement;
      while (parent && parent !== root && parent.nodeType === Node.ELEMENT_NODE) {
        if (isStrongInteractive(parent)) return true;
        parent = parent.parentElement;
      }
      return false;
    }

    function attributesFor(el) {
      const out = {};
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const type = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase();
      const passwordInput = isPasswordInput(el);
      const names = [
        'id', 'class', 'name', 'type', 'placeholder', 'aria-label', 'role',
        'href', 'title', 'alt', 'value', 'checked', 'selected', 'disabled',
        'required', 'readonly', 'multiple', 'pattern', 'min', 'max',
        'maxlength', 'aria-expanded', 'aria-pressed', 'aria-checked',
        'aria-selected', 'aria-invalid', 'autocomplete', 'aria-autocomplete',
        'aria-haspopup', 'aria-controls', 'aria-owns', 'aria-activedescendant',
        'list', 'data-testid', 'data-test', 'data-qa'
      ];
      for (const name of names) {
        if (passwordInput && PASSWORD_VALUE_ATTRIBUTES.has(String(name).toLowerCase())) continue;
        const value = el.getAttribute && el.getAttribute(name);
        if (value != null && String(value) !== '') {
          out[name] = compact(redactPasswordValue(el, value), 500);
        }
      }
      // Reflect live properties rather than stale HTML attributes.
      if (passwordInput && passwordValuePopulated(el)) {
        out.value = PASSWORD_VALUE_MARKER;
      } else if ((tag === 'input' || tag === 'textarea') && typeof el.value === 'string' && el.value !== '') {
        out.value = compact(el.value, 500);
      }
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) out.checked = String(Boolean(el.checked));
      if (tag === 'option') out.selected = String(Boolean(el.selected));
      if (el.href) out.href = compact(el.href, 500);
      return out;
    }

    function scrollInfoFor(el) {
      const scrollHeight = Number(el.scrollHeight || 0);
      const clientHeight = Number(el.clientHeight || 0);
      const scrollWidth = Number(el.scrollWidth || 0);
      const clientWidth = Number(el.clientWidth || 0);
      const vertical = scrollHeight > clientHeight + 2;
      const horizontal = scrollWidth > clientWidth + 2;
      if (!vertical && !horizontal) return null;
      return {
        vertical,
        horizontal,
        scrollTop: Number(el.scrollTop || 0),
        scrollLeft: Number(el.scrollLeft || 0),
        scrollHeight,
        scrollWidth,
        clientHeight,
        clientWidth
      };
    }

    function scanRoot(root) {
      const strong = [];
      const weak = [];
      const seen = new Set();
      const shadowHosts = [];
      const frames = [];
      const candidateLimit = MAX_ELEMENTS * 8;

      // One tree walk supplies candidates, shadow hosts and frames. The old
      // path materialized the full tree three times and separately ran the
      // large interactive selector, multiplying style/layout work on every
      // observe. Strong candidates stay first to preserve index ordering.
      for (const el of root.querySelectorAll('*')) {
        if (isPasswordInput(el)) passwordStateFor(el);
        if (el.shadowRoot) shadowHosts.push(el);
        const tag = el.tagName && el.tagName.toLowerCase();
        if (tag === 'iframe' || tag === 'frame') frames.push(el);

        if (seen.size >= candidateLimit) continue;
        if (el.matches && el.matches(interactiveSelector)) {
          seen.add(el);
          strong.push(el);
          continue;
        }
        if (isInteractive(el)) {
          seen.add(el);
          weak.push(el);
        }
      }

      return { frames, nodes: strong.concat(weak), shadowHosts };
    }

    const elements = [];
    const selectorMap = {};
    let index = 1;

    function collect(root, framePath, rootPath, offsetX, offsetY, depth) {
      if (!root || depth > 8 || elements.length >= MAX_ELEMENTS) return;
      const scanned = scanRoot(root);
      const nodes = scanned.nodes;
      for (const el of nodes) {
        if (elements.length >= MAX_ELEMENTS) break;
        if (!isInteractive(el)) continue;
        if (!isVisible(el)) continue;
        if (hasInteractiveAncestor(el, root)) continue;
        const rect = el.getBoundingClientRect();
        const selector = selectorFor(el, root);
        const tag = el.tagName.toLowerCase();
        const role = normalizedRole(el);
        const type = String(el.getAttribute('type') || '').toLowerCase();
        const scroll = scrollInfoFor(el);
        const item = {
          index,
          selectorIndex: index,
          tag,
          role,
          type,
          text: textFor(el),
          selector,
          framePath,
          path: rootPath.concat([{ type: 'css', selector }]),
          attributes: attributesFor(el),
          capabilities: {
            clickable: isClickable(el),
            typeable: isTypeable(el) && !isDisabled(el),
            selectable: tag === 'select' && !isDisabled(el),
            upload: tag === 'input' && type === 'file' && !isDisabled(el),
            scrollable: Boolean(scroll)
          },
          disabled: isDisabled(el),
          readonly: isReadonly(el),
          scroll,
          rect: {
            x: rect.x + offsetX,
            y: rect.y + offsetY,
            width: rect.width,
            height: rect.height,
            top: rect.top + offsetY,
            right: rect.right + offsetX,
            bottom: rect.bottom + offsetY,
            left: rect.left + offsetX
          }
        };
        elements.push(item);
        selectorMap[index] = item;
        index += 1;
      }

      for (const host of scanned.shadowHosts) {
        if (elements.length >= MAX_ELEMENTS) break;
        if (!isVisible(host)) continue;
        collect(
          host.shadowRoot,
          framePath,
          rootPath.concat([{ type: 'shadow', selector: selectorFor(host, root) }]),
          offsetX,
          offsetY,
          depth + 1
        );
      }

      for (const frame of scanned.frames) {
        if (elements.length >= MAX_ELEMENTS) break;
        if (!isVisible(frame)) continue;
        try {
          const childDoc = frame.contentDocument;
          if (!childDoc) continue;
          const frameRect = frame.getBoundingClientRect();
          collect(
            childDoc,
            framePath.concat(selectorFor(frame)),
            rootPath.concat([{ type: 'frame', selector: selectorFor(frame, root) }]),
            offsetX + frameRect.left + Number(frame.clientLeft || 0),
            offsetY + frameRect.top + Number(frame.clientTop || 0),
            depth + 1
          );
        } catch {
          // Cross-origin frames require CDP session traversal; handled by the
          // target/frame manager migration, not same-document JS traversal.
        }
      }
    }

    // 顶层偏移用主文档滚动量,使 in-page 元素 rect 变成【文档坐标】(viewport rect + scroll),
    // 与 enhanced 的 DOMSnapshot bounds(文档坐标)一致 → mergeObservedElements 的 geoSig 去重在
    // 任意滚动位置都成立(否则滚动后两者差 scrollY、同一元素双发)。
    collect(document, [], [], (window.scrollX || window.pageXOffset || 0), (window.scrollY || window.pageYOffset || 0), 0);

    ${publishSelectorMap === false ? '' : 'window.__fanBrowserRuntimeSelectorMap = selectorMap;'}
    const textSummary = elements.map(el => {
      const attrs = [];
      if (el.role) attrs.push('role=' + JSON.stringify(el.role));
      if (el.type) attrs.push('type=' + JSON.stringify(el.type));
      if (el.attributes && el.attributes.name) attrs.push('name=' + JSON.stringify(el.attributes.name));
      if (el.attributes && el.attributes.placeholder) attrs.push('placeholder=' + JSON.stringify(el.attributes.placeholder));
      if (el.capabilities && el.capabilities.scrollable) attrs.push('scrollable');
      if (el.disabled) attrs.push('disabled');
      if (el.readonly) attrs.push('readonly');
      const attrText = attrs.length ? ' ' + attrs.join(' ') : '';
      return '[' + el.index + ']<' + el.tag + attrText + '>' + (el.text || el.selector);
    }).join('\\n');

    const pageText = compact(redactPageText(document.body ? document.body.innerText : ''), 4000);
    const docEl = document.scrollingElement || document.documentElement;

    return {
      url: location.href,
      title: redactPageText(document.title),
      // 真实加载态(替代 page_stats 的字符比例猜测):'loading'|'interactive'|'complete'。
      readyState: document.readyState,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        scrollHeight: docEl ? docEl.scrollHeight : 0,
        scrollWidth: docEl ? docEl.scrollWidth : 0,
        hasMoreAbove: window.scrollY > 0,
        hasMoreBelow: docEl ? window.scrollY + window.innerHeight < docEl.scrollHeight - 2 : false
      },
      elements,
      text: textSummary,
      pageText,
      overlay: detectOverlay()
    };
  })()`
}

function buildPageMetadataExpression() {
  return `(() => {
    const compact = (value, max = 4000) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    ${OVERLAY_DETECTION_SOURCE}
    const docEl = document.scrollingElement || document.documentElement;
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        scrollHeight: docEl ? docEl.scrollHeight : 0,
        scrollWidth: docEl ? docEl.scrollWidth : 0,
        hasMoreAbove: window.scrollY > 0,
        hasMoreBelow: docEl ? window.scrollY + window.innerHeight < docEl.scrollHeight - 2 : false
      },
      elements: [],
      text: '',
      pageText: compact(document.body ? document.body.innerText : ''),
      overlay: detectOverlay()
    };
  })()`
}

module.exports = { buildObserveExpression, buildPageMetadataExpression }
