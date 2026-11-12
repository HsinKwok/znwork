/* 极简 jQuery 兼容层：只实现本项目实际用到的子集，替代 89KB 的 jQuery。
   覆盖：$(选择器/元素/HTML/函数)、集合遍历、class、attr/prop/data、val、
   text/html/append/empty/remove、css/hide/show/toggle、on/click/submit/keypress/change、
   serializeArray、find、is(':checked')。 */
(function (window, document) {
    'use strict';

    if (window.$ && window.$.jqueryLite) return;

    function toArray(list) { return Array.prototype.slice.call(list); }

    function Q(elements) {
        this.length = 0;
        for (var i = 0; i < elements.length; i++) this[this.length++] = elements[i];
    }

    // 把 jQuery 的 :first/:last 伪类翻译成等价 CSS 选择器
    function toCssSelector(selector) {
        return selector
            .replace(/:first\b/g, ':first-child')
            .replace(/:last\b/g, ':last-child');
    }

    function query(selector, context) {
        var roots = context ? toElements(context) : [document];
        var out = [];
        roots.forEach(function (root) {
            if (root && root.querySelectorAll) {
                out.push.apply(out, toArray(root.querySelectorAll(toCssSelector(selector))));
            }
        });
        return out;
    }

    function toElements(arg, context) {
        if (!arg) return [];
        if (arg instanceof Q) return toArray(arg);
        if (arg === window || arg === document) return [arg];
        if (typeof arg === 'string') {
            var s = arg.trim();
            if (s.charAt(0) === '<') {
                var tpl = document.createElement('template');
                tpl.innerHTML = s;
                return toArray(tpl.content.children);
            }
            return query(s, context);
        }
        if (arg.nodeType) return [arg];
        if (typeof arg.length === 'number') return toArray(arg);
        return [arg];
    }

    // 元素默认 display 值（用于还原被 CSS 类隐藏的元素，对齐 jQuery show 的行为）
    function defaultDisplay(el) {
        var map = {
            LI: 'list-item', TABLE: 'table', TR: 'table-row', TD: 'table-cell',
            TH: 'table-cell', THEAD: 'table-header-group', TBODY: 'table-row-group',
            TFOOT: 'table-footer-group', OPTION: 'block', SELECT: 'inline-block',
            INPUT: 'inline-block', TEXTAREA: 'inline-block', IMG: 'inline-block',
            BUTTON: 'inline-block', SPAN: 'inline', A: 'inline'
        };
        return map[el.tagName] || 'block';
    }

    function showElement(el) {
        el.style.display = '';
        if (window.getComputedStyle && window.getComputedStyle(el).display === 'none') {
            el.style.display = defaultDisplay(el);
        }
    }

    function hideElement(el) {
        el.style.display = 'none';
    }

    function trigger(el, name) {
        if (!el) return;
        var event;
        try {
            event = new Event(name, { bubbles: true });
        } catch (e) {
            event = document.createEvent('Event');
            event.initEvent(name, true, true);
        }
        el.dispatchEvent(event);
    }

    Q.prototype = {
        each: function (fn) {
            for (var i = 0; i < this.length; i++) fn.call(this[i], i, this[i]);
            return this;
        },
        map: function (fn) {
            var out = [];
            for (var i = 0; i < this.length; i++) {
                var value = fn.call(this[i], i, this[i]);
                if (value == null) continue;
                out.push.apply(out, Array.isArray(value) ? value : [value]);
            }
            return new Q(out);
        },
        get: function (index) {
            return typeof index === 'number' ? this[index] : toArray(this);
        },
        find: function (selector) {
            var out = [];
            this.each(function () { out.push.apply(out, query(selector, this)); });
            return new Q(out);
        },
        is: function (selector) {
            if (!this.length) return false;
            var el = this[0];
            if (selector.charAt(0) === ':') {
                if (selector === ':checked') return !!el.checked;
                if (selector === ':selected') return !!el.selected;
                if (selector === ':disabled') return !!el.disabled;
                return false;
            }
            return el.matches ? el.matches(selector) : false;
        },
        addClass: function (names) {
            names = String(names).split(/\s+/);
            return this.each(function () {
                names.forEach(function (name) { if (name) this.classList.add(name); }, this);
            });
        },
        removeClass: function (names) {
            names = String(names).split(/\s+/);
            return this.each(function () {
                names.forEach(function (name) { if (name) this.classList.remove(name); }, this);
            });
        },
        on: function (events, selector, fn) {
            if (typeof selector === 'function') { fn = selector; selector = null; }
            var names = String(events).split(/\s+/);
            return this.each(function () {
                var el = this;
                names.forEach(function (name) {
                    if (!name) return;
                    el.addEventListener(name, function (event) {
                        if (name === 'keypress' || name === 'keyup' || name === 'keydown') {
                            if (event.which == null) event.which = event.keyCode;
                        }
                        if (!selector) {
                            if (fn.call(el, event) === false) {
                                event.preventDefault();
                                event.stopPropagation();
                            }
                            return;
                        }
                        var target = event.target && event.target.closest ? event.target.closest(selector) : null;
                        if (target && el.contains && el.contains(target)) {
                            if (fn.call(target, event) === false) {
                                event.preventDefault();
                                event.stopPropagation();
                            }
                        }
                    });
                });
            });
        },
        click: function (fn) {
            return fn ? this.on('click', fn) : this.each(function () { this.click(); });
        },
        submit: function (fn) {
            return fn ? this.on('submit', fn) : this.each(function () { trigger(this, 'submit'); });
        },
        keypress: function (fn) { return this.on('keypress', fn); },
        change: function (fn) {
            return fn ? this.on('change', fn) : this.each(function () { trigger(this, 'change'); });
        },
        attr: function (name, value) {
            if (value === undefined) return this.length ? this[0].getAttribute(name) : undefined;
            return this.each(function () { this.setAttribute(name, value); });
        },
        prop: function (name, value) {
            if (value === undefined) return this.length ? this[0][name] : undefined;
            return this.each(function () { this[name] = value; });
        },
        data: function (key, value) {
            var camel = key.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
            if (value === undefined) {
                if (!this.length || !this[0].dataset) return undefined;
                return this[0].dataset[camel];
            }
            return this.each(function () { if (this.dataset) this.dataset[camel] = value; });
        },
        val: function (value) {
            if (value === undefined) {
                var el = this[0];
                if (!el) return undefined;
                if (el.multiple) {
                    return toArray(el.selectedOptions).map(function (option) { return option.value; });
                }
                return el.value;
            }
            return this.each(function () {
                if (this.multiple && Array.isArray(value)) {
                    toArray(this.options).forEach(function (option) {
                        option.selected = value.indexOf(option.value) !== -1;
                    });
                } else {
                    this.value = value;
                }
            });
        },
        text: function (value) {
            if (value === undefined) return this.length ? this[0].textContent : '';
            return this.each(function () { this.textContent = value; });
        },
        html: function (value) {
            if (value === undefined) return this.length ? this[0].innerHTML : '';
            return this.each(function () { this.innerHTML = value; });
        },
        append: function (content) {
            var nodes = typeof content === 'string' ? content : toElements(content);
            return this.each(function () {
                if (typeof nodes === 'string') {
                    this.insertAdjacentHTML('beforeend', nodes);
                    return;
                }
                nodes.forEach(function (node) { this.appendChild(node); }, this);
            });
        },
        empty: function () {
            return this.each(function () { this.innerHTML = ''; });
        },
        remove: function () {
            return this.each(function () { if (this.parentNode) this.parentNode.removeChild(this); });
        },
        css: function (prop, value) {
            if (prop && typeof prop === 'object') {
                return this.each(function () {
                    for (var key in prop) {
                        if (Object.prototype.hasOwnProperty.call(prop, key)) this.style[key] = prop[key];
                    }
                });
            }
            if (value === undefined) return this.length ? this[0].style[prop] : undefined;
            return this.each(function () { this.style[prop] = value; });
        },
        hide: function () {
            return this.each(function () { hideElement(this); });
        },
        show: function () {
            return this.each(function () { showElement(this); });
        },
        toggle: function (show) {
            return this.each(function () {
                var next = show;
                if (next === undefined) {
                    next = !window.getComputedStyle || window.getComputedStyle(this).display === 'none';
                }
                if (next) showElement(this);
                else hideElement(this);
            });
        },
        serializeArray: function () {
            var out = [];
            this.each(function () {
                var fields = this.elements ? toArray(this.elements) : query('input,select,textarea', this);
                fields.forEach(function (field) {
                    if (!field.name || field.disabled) return;
                    if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) return;
                    if (field.tagName === 'SELECT' && field.multiple) {
                        toArray(field.selectedOptions).forEach(function (option) {
                            out.push({ name: field.name, value: option.value });
                        });
                    } else {
                        out.push({ name: field.name, value: field.value });
                    }
                });
            });
            return out;
        },
        ready: function (fn) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', fn);
            } else {
                fn();
            }
            return this;
        }
    };

    function $(arg, context) {
        if (typeof arg === 'function') return new Q([document]).ready(arg);
        return new Q(toElements(arg, context));
    }

    $.jqueryLite = true;
    $.fn = Q.prototype;
    window.$ = window.jQuery = $;
})(window, document);
