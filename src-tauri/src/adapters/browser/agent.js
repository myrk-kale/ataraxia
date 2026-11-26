/*
 * Ataraxia's page bridge. It is injected into every page of the built-in browser before the page's
 * own scripts run, and gives the app (and, through it, the agent of a chat) a small, stable
 * surface to look at the page and to act on it:
 *
 *   - snapshot/find/read/inspect: what is on the page, as text an agent can use, with short refs
 *     ("e12") for the elements it may act on;
 *   - click, hover, type, fill, press, select, scroll, drag, wait: actions that move a visible
 *     virtual mouse to the element first, so the developer sees what the agent is doing;
 *   - console, errors and network capture (fetch, XHR, WebSocket, EventSource, resources), kept in
 *     the page and drained by the app, which is how the HTTP calls behind a page become visible;
 *   - storage and performance reads, for debugging.
 *
 * Commands run through `__ataraxia.exec(id, fn)`: a quick one answers at once, one that has to wait
 * (a wait, an animation) answers `{pending:true}` and is read with `__ataraxia.poll(id)`. The page
 * can see this object, so nothing here is a secret; what keeps it safe is that the app only ever
 * runs it in tabs it opened or the developer shared.
 *
 * The events made here are synthetic (`isTrusted` is false): most pages and frameworks react to
 * them like to a real click, but a few widgets that insist on a trusted event will not.
 */
(function () {
  "use strict";
  if (window.__ataraxia || window.top !== window) {
    return;
  }

  var VERSION = 1;
  var MAX_ENTRIES = { console: 1000, errors: 300, net: 600 };
  var BODY_CAP = 200 * 1024;
  var TEXT_CAP = 2000;
  var pageId = Math.random().toString(36).slice(2, 10);
  var counter = 0;

  /** One counter for every change in the logs, so the app can ask for "what is new since n". */
  function bump() {
    counter += 1;
    return counter;
  }

  var logs = { console: [], errors: [], net: [] };
  var pendingRequests = 0;
  var lastNetworkActivity = Date.now();

  // ------------------------------------------------------------------ values

  function clip(text, max) {
    text = String(text);
    return text.length > max ? text.slice(0, max) + "…(" + (text.length - max) + " more)" : text;
  }

  /** A JSON-safe rendering of any value: DOM nodes, errors, functions, cycles and size are handled. */
  function plain(value, depth, seen) {
    depth = depth === undefined ? 0 : depth;
    seen = seen || [];
    var type = typeof value;
    if (value === null || type === "boolean") return value;
    if (type === "undefined") return "undefined";
    if (type === "number") return isFinite(value) ? value : String(value);
    if (type === "string") return clip(value, TEXT_CAP);
    if (type === "bigint") return value.toString() + "n";
    if (type === "symbol") return value.toString();
    if (type === "function") return "[Function" + (value.name ? " " + value.name : "") + "]";
    if (value instanceof Error || Object.prototype.toString.call(value) === "[object Error]") {
      return { error: value.name + ": " + value.message, stack: clip(value.stack || "", 800) };
    }
    if (typeof Node !== "undefined" && value instanceof Node) return describe(value);
    if (typeof Window !== "undefined" && value === window) return "[Window]";
    if (seen.indexOf(value) !== -1) return "[Circular]";
    if (depth >= 4) return Array.isArray(value) ? "[Array(" + value.length + ")]" : "[Object]";
    seen = seen.concat([value]);
    if (Array.isArray(value)) {
      var items = value.slice(0, 100).map(function (item) { return plain(item, depth + 1, seen); });
      if (value.length > 100) items.push("…(" + (value.length - 100) + " more)");
      return items;
    }
    if (value instanceof Map) return { "[Map]": plain(Array.from(value.entries()), depth + 1, seen) };
    if (value instanceof Set) return { "[Set]": plain(Array.from(value.values()), depth + 1, seen) };
    if (value instanceof Date) return isNaN(value) ? "Invalid Date" : value.toISOString();
    if (value instanceof RegExp) return value.toString();
    var out = {};
    var keys;
    try {
      keys = Object.keys(value);
    } catch (e) {
      return "[Object]";
    }
    keys.slice(0, 100).forEach(function (key) {
      try {
        out[key] = plain(value[key], depth + 1, seen);
      } catch (e) {
        out[key] = "[Unreadable]";
      }
    });
    if (keys.length > 100) out["…"] = keys.length - 100 + " more keys";
    return out;
  }

  function stringify(value) {
    try {
      return JSON.stringify(plain(value));
    } catch (e) {
      return JSON.stringify("[Unserialisable]");
    }
  }

  /** `<tag#id.class>` for the log line of an element. */
  function describe(node) {
    if (!node || node.nodeType !== 1) return node && node.nodeName ? "[" + node.nodeName + "]" : String(node);
    var out = "<" + node.tagName.toLowerCase();
    if (node.id) out += "#" + node.id;
    var cls = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) out += "." + cls.join(".");
    return out + ">";
  }

  // ------------------------------------------------------------------ logs

  function push(kind, entry) {
    entry.seq = bump();
    entry.chg = entry.seq;
    var list = logs[kind];
    list.push(entry);
    if (list.length > MAX_ENTRIES[kind]) list.shift();
    return entry;
  }

  function stackTop() {
    try {
      var lines = String(new Error().stack || "").split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || /^Error/.test(line) || line.indexOf("__ataraxia") !== -1) continue;
        if (/user-script|agent\.js|ataraxia|\[native code\]/.test(line)) continue;
        return clip(line, 200);
      }
    } catch (e) {
      /* no stack */
    }
    return "";
  }

  function logConsole(level, args) {
    var text = Array.prototype.map
      .call(args, function (arg) {
        return typeof arg === "string" ? arg : stringify(arg);
      })
      .join(" ");
    push("console", { level: level, text: clip(text, TEXT_CAP), t: Date.now(), page: location.href });
  }

  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      try {
        logConsole(level, arguments);
      } catch (e) {
        /* never break the page's own logging */
      }
      return original.apply(this, arguments);
    };
  });
  var originalAssert = console.assert;
  if (typeof originalAssert === "function") {
    console.assert = function (condition) {
      if (!condition) {
        try {
          logConsole("error", ["Assertion failed:"].concat(Array.prototype.slice.call(arguments, 1)));
        } catch (e) {
          /* ignore */
        }
      }
      return originalAssert.apply(this, arguments);
    };
  }

  function logError(kind, message, extra) {
    var entry = { kind: kind, message: clip(message, TEXT_CAP), t: Date.now(), page: location.href };
    if (extra) Object.keys(extra).forEach(function (key) { entry[key] = extra[key]; });
    push("errors", entry);
  }

  window.addEventListener(
    "error",
    function (event) {
      var target = event.target;
      if (target && target !== window && target.tagName) {
        var source = target.currentSrc || target.src || target.href || "";
        logError("resource", "Failed to load " + target.tagName.toLowerCase() + ": " + source, { url: source });
        return;
      }
      logError("exception", event.message || "Script error", {
        source: event.filename || "",
        line: event.lineno || 0,
        column: event.colno || 0,
        stack: event.error && event.error.stack ? clip(event.error.stack, 1200) : "",
      });
    },
    true
  );
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    var isError = reason instanceof Error || Object.prototype.toString.call(reason) === "[object Error]";
    var message = isError ? reason.name + ": " + reason.message : stringify(reason);
    logError("rejection", "Unhandled promise rejection: " + message, {
      stack: reason && reason.stack ? clip(reason.stack, 1200) : "",
    });
  });
  document.addEventListener("securitypolicyviolation", function (event) {
    logError("csp", "Blocked by Content-Security-Policy (" + event.violatedDirective + "): " + (event.blockedURI || ""), {
      url: event.blockedURI || "",
    });
  });

  // ------------------------------------------------------------------ network

  function absolute(url) {
    try {
      return new URL(String(url), location.href).href;
    } catch (e) {
      return String(url);
    }
  }

  function headersToObject(headers) {
    var out = {};
    try {
      if (!headers) return out;
      if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
        headers.forEach(function (value, key) { out[String(key).toLowerCase()] = String(value); });
      } else if (Array.isArray(headers)) {
        headers.forEach(function (pair) { out[String(pair[0]).toLowerCase()] = String(pair[1]); });
      } else {
        Object.keys(headers).forEach(function (key) { out[key.toLowerCase()] = String(headers[key]); });
      }
    } catch (e) {
      /* headers that cannot be read are left out */
    }
    return out;
  }

  function isTextual(type) {
    return /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|.*\+json|.*\+xml))/i.test(type || "");
  }

  /** The text of a request body, or a short note for what is not text. */
  function bodyText(body) {
    if (body === undefined || body === null) return { text: "" };
    if (typeof body === "string") return clipBody(body);
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return clipBody(body.toString());
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      var parts = [];
      body.forEach(function (value, key) {
        parts.push(key + "=" + (typeof value === "string" ? clip(value, 200) : "[File " + (value.name || "") + " " + value.size + " bytes]"));
      });
      return { text: parts.join("&"), note: "multipart/form-data" };
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) return { text: "", note: "[Blob " + body.size + " bytes " + body.type + "]" };
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { text: "", note: "[binary " + body.byteLength + " bytes]" };
    return { text: clip(String(body), 1000) };
  }

  function clipBody(text) {
    if (text.length > BODY_CAP) return { text: text.slice(0, BODY_CAP), truncated: true, size: text.length };
    return { text: text, size: text.length };
  }

  function beginRequest(kind, method, url) {
    pendingRequests += 1;
    lastNetworkActivity = Date.now();
    return push("net", {
      id: "n" + pageId + "-" + (counter + 1),
      kind: kind,
      method: String(method || "GET").toUpperCase(),
      url: absolute(url),
      page: location.href,
      t: Date.now(),
      status: 0,
      done: false,
      initiator: stackTop(),
    });
  }

  function touch(entry) {
    entry.chg = bump();
  }

  function endRequest(entry, fields) {
    Object.keys(fields).forEach(function (key) { entry[key] = fields[key]; });
    entry.done = true;
    entry.duration = Date.now() - entry.t;
    pendingRequests = Math.max(0, pendingRequests - 1);
    lastNetworkActivity = Date.now();
    touch(entry);
  }

  if (typeof window.fetch === "function") {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var entry;
      try {
        var isRequest = typeof Request !== "undefined" && input instanceof Request;
        var url = isRequest ? input.url : input;
        var method = (init && init.method) || (isRequest && input.method) || "GET";
        entry = beginRequest("fetch", method, url);
        var headers = headersToObject((init && init.headers) || (isRequest ? input.headers : null));
        entry.reqHeaders = headers;
        var body = init && init.body !== undefined ? init.body : null;
        if (body !== null) {
          var sent = bodyText(body);
          entry.reqBody = sent.text;
          if (sent.note) entry.reqNote = sent.note;
          if (sent.truncated) entry.reqTruncated = true;
        }
      } catch (e) {
        entry = null;
      }
      var promise = originalFetch.apply(this, arguments);
      if (!entry) return promise;
      return promise.then(
        function (response) {
          try {
            var type = response.headers.get("content-type") || "";
            var fields = {
              status: response.status,
              statusText: response.statusText,
              ok: response.ok,
              resHeaders: headersToObject(response.headers),
              mime: type.split(";")[0].trim(),
              redirected: response.redirected,
            };
            if (response.url && response.url !== entry.url) fields.finalUrl = response.url;
            if (isTextual(type) && !/event-stream/i.test(type) && response.body) {
              readCapped(response.clone()).then(
                function (read) {
                  fields.resBody = read.text;
                  if (read.truncated) fields.resTruncated = true;
                  fields.resSize = read.size;
                  endRequest(entry, fields);
                },
                function () {
                  endRequest(entry, fields);
                }
              );
            } else {
              if (/event-stream/i.test(type)) fields.resNote = "[event stream]";
              else if (type) fields.resNote = "[" + type + "]";
              endRequest(entry, fields);
            }
          } catch (e) {
            endRequest(entry, { error: String(e) });
          }
          return response;
        },
        function (error) {
          endRequest(entry, { error: error && error.message ? error.message : String(error) });
          throw error;
        }
      );
    };
  }

  /** Reads at most BODY_CAP characters of a cloned response, then lets go of the rest. */
  function readCapped(response) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var text = "";
    var size = 0;
    function step() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return { text: text, size: size };
        size += chunk.value.byteLength;
        if (text.length < BODY_CAP) text += decoder.decode(chunk.value, { stream: true });
        if (size > BODY_CAP * 4) {
          reader.cancel();
          return { text: text.slice(0, BODY_CAP), truncated: true, size: size };
        }
        return step();
      });
    }
    return step().then(function (read) {
      if (read.text.length > BODY_CAP) {
        read.text = read.text.slice(0, BODY_CAP);
        read.truncated = true;
      }
      return read;
    });
  }

  if (typeof XMLHttpRequest !== "undefined") {
    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;
    var xhrHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ataraxia = { method: method, url: url, headers: {} };
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this.__ataraxia) this.__ataraxia.headers[String(name).toLowerCase()] = String(value);
      return xhrHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var meta = this.__ataraxia;
      var xhr = this;
      if (meta) {
        try {
          var entry = beginRequest("xhr", meta.method, meta.url);
          entry.reqHeaders = meta.headers;
          if (body !== undefined && body !== null) {
            var sent = bodyText(body);
            entry.reqBody = sent.text;
            if (sent.note) entry.reqNote = sent.note;
            if (sent.truncated) entry.reqTruncated = true;
          }
          xhr.addEventListener("loadend", function () {
            var fields = { status: xhr.status, statusText: xhr.statusText, ok: xhr.status >= 200 && xhr.status < 400 };
            try {
              var raw = xhr.getAllResponseHeaders() || "";
              var headers = {};
              raw.trim().split(/[\r\n]+/).forEach(function (line) {
                var at = line.indexOf(":");
                if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
              });
              fields.resHeaders = headers;
              fields.mime = (headers["content-type"] || "").split(";")[0].trim();
              if (xhr.responseType === "" || xhr.responseType === "text") {
                var read = clipBody(xhr.responseText || "");
                fields.resBody = read.text;
                if (read.truncated) fields.resTruncated = true;
                fields.resSize = read.size;
              } else {
                fields.resNote = "[" + xhr.responseType + "]";
              }
            } catch (e) {
              /* a response that cannot be read keeps its status */
            }
            if (xhr.status === 0) fields.error = "network error or aborted";
            endRequest(entry, fields);
          });
        } catch (e) {
          /* capture is best effort */
        }
      }
      return xhrSend.apply(this, arguments);
    };
  }

  if (typeof window.WebSocket === "function") {
    var NativeSocket = window.WebSocket;
    var Wrapped = function (url, protocols) {
      var socket = protocols === undefined ? new NativeSocket(url) : new NativeSocket(url, protocols);
      try {
        var entry = push("net", {
          id: "n" + pageId + "-" + (counter + 1),
          kind: "ws",
          method: "GET",
          url: absolute(url),
          page: location.href,
          t: Date.now(),
          status: 101,
          done: false,
          frames: [],
          initiator: stackTop(),
        });
        var frame = function (direction, data) {
          if (entry.frames.length < 50) {
            entry.frames.push({ d: direction, t: Date.now(), data: typeof data === "string" ? clip(data, 500) : "[binary]" });
          }
          touch(entry);
        };
        socket.addEventListener("message", function (event) { frame("in", event.data); });
        var send = socket.send;
        socket.send = function (data) {
          frame("out", data);
          return send.apply(socket, arguments);
        };
        socket.addEventListener("close", function (event) {
          entry.done = true;
          entry.duration = Date.now() - entry.t;
          entry.closeCode = event.code;
          touch(entry);
        });
        socket.addEventListener("error", function () {
          entry.error = "WebSocket error";
          touch(entry);
        });
      } catch (e) {
        /* capture is best effort */
      }
      return socket;
    };
    Wrapped.prototype = NativeSocket.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (name) { Wrapped[name] = NativeSocket[name]; });
    window.WebSocket = Wrapped;
  }

  if (typeof PerformanceObserver === "function") {
    try {
      var seen = {};
      var observer = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (item) {
          var initiator = item.initiatorType || "other";
          // What fetch and XHR already recorded has more detail than the timing entry does.
          if (initiator === "fetch" || initiator === "xmlhttprequest" || initiator === "beacon") return;
          if (seen[item.name + item.startTime]) return;
          seen[item.name + item.startTime] = true;
          push("net", {
            id: "n" + pageId + "-" + (counter + 1),
            kind: "resource",
            method: "GET",
            url: item.name,
            page: location.href,
            t: Math.round(performance.timeOrigin + item.startTime),
            status: item.responseStatus || 0,
            done: true,
            duration: Math.round(item.duration),
            resSize: item.transferSize || item.encodedBodySize || 0,
            mime: initiator,
          });
        });
      });
      observer.observe({ type: "resource", buffered: true });
    } catch (e) {
      /* the browser does not expose resource timings */
    }
  }

  // ------------------------------------------------------------------ elements and refs

  var ids = new WeakMap();
  var refs = {};
  var nextRef = 1;

  function refOf(el) {
    var known = ids.get(el);
    if (known) return known;
    var id = "e" + nextRef++;
    ids.set(el, id);
    refs[id] = typeof WeakRef === "function" ? new WeakRef(el) : { deref: function () { return el; } };
    return id;
  }

  function fromRef(id) {
    var holder = refs[id];
    var el = holder && holder.deref();
    if (!el || !el.isConnected) {
      throw new Error("ref " + id + " is no longer on the page: take a new snapshot");
    }
    return el;
  }

  function style(el) {
    try {
      return getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }

  /** What a person would read in an element: innerText where the browser has it. */
  function pageText(el) {
    return (el && (el.innerText !== undefined ? el.innerText : el.textContent)) || "";
  }

  function visible(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var css = style(node);
      if (css && (css.display === "none" || css.visibility === "hidden" || css.visibility === "collapse")) {
        if (node === el || css.display === "none") return false;
        if (css.visibility === "hidden") return false;
      }
      if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  }

  function inViewport(el) {
    var rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function textOf(el, max) {
    var text = (el.innerText !== undefined ? el.innerText : el.textContent) || "";
    return clip(text.replace(/\s+/g, " ").trim(), max || 100);
  }

  function labelText(el) {
    var parts = [];
    if (el.labels && el.labels.length) {
      Array.prototype.forEach.call(el.labels, function (label) { parts.push(textOf(label, 80)); });
    }
    return parts.join(" ").trim();
  }

  function nameOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return clip(aria.trim(), 100);
    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var joined = by
        .split(/\s+/)
        .map(function (id) {
          var target = document.getElementById(id);
          return target ? textOf(target, 80) : "";
        })
        .join(" ")
        .trim();
      if (joined) return joined;
    }
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      var label = labelText(el);
      if (label) return label;
      if (tag === "input" && /^(button|submit|reset)$/i.test(el.type)) return clip(el.value || el.type, 100);
      if (el.placeholder) return clip(el.placeholder, 100);
      if (el.title) return clip(el.title, 100);
      if (el.name) return el.name;
      return "";
    }
    if (tag === "img") return clip(el.getAttribute("alt") || el.title || "", 100);
    var text = textOf(el, 100);
    if (text) return text;
    var img = el.querySelector && el.querySelector("img[alt]");
    if (img && img.getAttribute("alt")) return clip(img.getAttribute("alt"), 100);
    var svgTitle = el.querySelector && el.querySelector("title");
    if (svgTitle) return clip(svgTitle.textContent, 100);
    return clip(el.title || el.getAttribute("value") || "", 100);
  }

  var INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio",
    range: "slider", number: "spinbutton", search: "searchbox", file: "file", color: "color", date: "date",
    "datetime-local": "date", month: "date", week: "date", time: "time",
  };

  /** The role an element plays, or "" when it is not something to act on. */
  function roleOf(el) {
    var explicit = (el.getAttribute("role") || "").split(/\s+/)[0];
    var tag = el.tagName.toLowerCase();
    if (explicit && explicit !== "presentation" && explicit !== "none" && explicit !== "generic") {
      if (/^(button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|textbox|searchbox|combobox|listbox|slider|spinbutton|treeitem|gridcell|cell|row|columnheader)$/.test(explicit)) return explicit;
    }
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var type = (el.type || "text").toLowerCase();
      if (type === "hidden") return "";
      return INPUT_ROLES[type] || "textbox";
    }
    if (el.isContentEditable && (el.getAttribute("contenteditable") === "" || el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "plaintext-only")) return "textbox";
    if (el.hasAttribute("onclick") || (el.tabIndex >= 0 && tag !== "body" && tag !== "html" && el.hasAttribute("tabindex"))) return "clickable";
    return "";
  }

  var CONTAINERS = { nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary", form: "form", dialog: "dialog", table: "table", section: "region", article: "article" };

  function state(el) {
    var out = [];
    var tag = el.tagName.toLowerCase();
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el.checked || el.getAttribute("aria-checked") === "true") out.push("checked");
    if (el.getAttribute("aria-expanded")) out.push("expanded=" + el.getAttribute("aria-expanded"));
    if (el.getAttribute("aria-selected") === "true") out.push("selected");
    if (el.getAttribute("aria-pressed") === "true") out.push("pressed");
    if (el.required) out.push("required");
    if (el.readOnly) out.push("readonly");
    if (document.activeElement === el) out.push("focused");
    if (tag === "input" || tag === "textarea") {
      var type = (el.type || "").toLowerCase();
      if (type === "password") out.push(el.value ? 'value="••••"' : 'value=""');
      else if (type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit" && type !== "file") out.push("value=" + JSON.stringify(clip(el.value || "", 60)));
    } else if (tag === "select") {
      var chosen = Array.prototype.filter.call(el.options, function (option) { return option.selected; }).map(function (option) { return option.text.trim(); });
      out.push("value=" + JSON.stringify(clip(chosen.join(", "), 60)));
    } else if (el.isContentEditable) {
      out.push("value=" + JSON.stringify(clip(el.textContent || "", 60)));
    }
    if (tag === "a" && el.getAttribute("href")) out.push("href=" + clip(el.getAttribute("href"), 80));
    if (tag === "input" && el.placeholder) out.push("placeholder=" + JSON.stringify(clip(el.placeholder, 40)));
    return out;
  }

  // ------------------------------------------------------------------ snapshot

  function snapshot(options) {
    options = options || {};
    var maxChars = options.maxChars || 12000;
    var root = options.selector ? document.querySelector(options.selector) : document.body;
    if (!root) throw new Error("nothing matches " + options.selector);
    var viewportOnly = !!options.viewportOnly;
    var lines = [];
    var size = 0;
    var nodes = 0;
    var truncated = false;

    function emit(depth, text) {
      if (truncated) return;
      var line = new Array(depth + 1).join("  ") + text;
      if (size + line.length > maxChars) {
        truncated = true;
        return;
      }
      lines.push(line);
      size += line.length + 1;
    }

    function walk(node, depth) {
      if (truncated || nodes > 8000) return;
      if (node.nodeType === 3) return;
      if (node.nodeType !== 1) return;
      nodes += 1;
      var tag = node.tagName.toLowerCase();
      if (/^(script|style|noscript|template|head|meta|link|svg|path)$/.test(tag)) return;
      if (!visible(node)) return;
      var role = roleOf(node);
      if (role) {
        if (viewportOnly && !inViewport(node)) return;
        var name = nameOf(node);
        var bits = state(node);
        if (!viewportOnly && !inViewport(node)) bits.push("offscreen");
        emit(depth, "[" + refOf(node) + "] " + role + (name ? " " + JSON.stringify(name) : "") + (bits.length ? " " + bits.join(" ") : ""));
        if (tag === "select") {
          var labels = Array.prototype.slice.call(node.options, 0, 30).map(function (option) { return option.text.trim(); });
          emit(depth + 1, "options: " + clip(labels.join(" | "), 300));
        }
        return;
      }
      if (/^h[1-6]$/.test(tag)) {
        var heading = textOf(node, 120);
        if (heading) emit(depth, "heading(" + tag[1] + ") " + JSON.stringify(heading));
        return;
      }
      if (tag === "img") {
        var alt = node.getAttribute("alt");
        if (alt) emit(depth, "img " + JSON.stringify(clip(alt, 80)));
        return;
      }
      if (tag === "iframe" || tag === "frame") {
        var inner;
        try {
          inner = node.contentDocument;
        } catch (e) {
          inner = null;
        }
        if (inner && inner.body) {
          emit(depth, "iframe " + JSON.stringify(node.title || node.name || ""));
          walk(inner.body, depth + 1);
        } else {
          emit(depth, "iframe (cross-origin) src=" + clip(node.src || "", 80));
        }
        return;
      }
      var container = CONTAINERS[tag] || (node.getAttribute("role") && /^(navigation|main|banner|contentinfo|complementary|form|dialog|alertdialog|search|region|list|menu|toolbar|tablist|grid|alert|status)$/.test(node.getAttribute("role")) ? node.getAttribute("role") : "");
      var before = lines.length;
      var nextDepth = depth;
      if (container) {
        var label = node.getAttribute("aria-label") || (tag === "dialog" ? textOf(node.querySelector("h1,h2,h3") || node, 60) : "");
        emit(depth, container + (label ? " " + JSON.stringify(clip(label, 60)) : "") + ":");
        nextDepth = depth + 1;
      }
      // Text that belongs to this element itself, not to a child that is listed on its own.
      var own = "";
      for (var child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) own += child.nodeValue;
      }
      own = own.replace(/\s+/g, " ").trim();
      // A label's words are already the name of the field it labels.
      if (tag === "label" && (node.control || node.querySelector("input,select,textarea"))) own = "";
      if (own.length > 1 && (!viewportOnly || inViewport(node))) emit(nextDepth, "text " + JSON.stringify(clip(own, 160)));
      if (node.shadowRoot) {
        for (var s = node.shadowRoot.firstElementChild; s; s = s.nextElementSibling) walk(s, nextDepth);
      }
      for (var c = node.firstElementChild; c; c = c.nextElementSibling) walk(c, nextDepth);
      // A container with nothing listed inside it is not worth a line.
      if (container && lines.length === before + 1) size -= lines.pop().length + 1;
    }

    walk(root, 0);
    var scrollMax = Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight);
    var header =
      "Page " + JSON.stringify(document.title || "") + " " + location.href + "\n" +
      "viewport " + window.innerWidth + "x" + window.innerHeight + ", scrolled " + Math.round(window.scrollY) + " of " + Math.round(scrollMax) + "px";
    var out = header + "\n" + lines.join("\n");
    if (truncated) out += "\n…truncated at " + maxChars + " characters: pass a selector, viewportOnly, or scroll and look again";
    if (!lines.length) out += "\n(nothing visible to act on yet: the page may still be loading)";
    return out;
  }

  // ------------------------------------------------------------------ targets

  function allVisible(selector) {
    return Array.prototype.filter.call(document.querySelectorAll(selector), visible);
  }

  function byText(text, role) {
    var wanted = String(text).toLowerCase().trim();
    var found = [];
    var candidates = document.querySelectorAll("a,button,input,select,textarea,summary,[role],[onclick],[tabindex],label,h1,h2,h3,h4,h5,h6,li,td,th,p,span,div");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!visible(el)) continue;
      var kind = roleOf(el);
      if (role && kind !== role) continue;
      var own = (kind ? nameOf(el) : textOf(el, 200)).toLowerCase();
      if (own === wanted) found.unshift(el);
      else if (own.indexOf(wanted) !== -1 && (kind || el.children.length === 0)) found.push(el);
      if (found.length > 40) break;
    }
    return found;
  }

  /** Resolves `{ref}`, `{selector, nth}`, `{text, role, nth}` or `{x, y}` to an element (or a point). */
  function resolve(target) {
    if (!target || typeof target !== "object") throw new Error("say what to act on: a ref, a selector, text or x/y");
    if (target.ref) return { el: fromRef(target.ref) };
    var nth = target.nth || 0;
    if (target.selector) {
      var matches = allVisible(target.selector);
      if (!matches.length) throw new Error("nothing visible matches " + target.selector);
      if (matches.length > 1 && target.nth === undefined && !target.first) {
        throw new Error(matches.length + " elements match " + target.selector + ": use a ref from a snapshot, or nth (0-" + (matches.length - 1) + ")");
      }
      return { el: matches[nth] || matches[0] };
    }
    if (target.text) {
      var hits = byText(target.text, target.role);
      if (!hits.length) throw new Error("no visible element has the text " + JSON.stringify(target.text));
      return { el: hits[nth] || hits[0] };
    }
    if (typeof target.x === "number" && typeof target.y === "number") return { point: { x: target.x, y: target.y } };
    throw new Error("say what to act on: a ref, a selector, text or x/y");
  }

  function centre(el) {
    var rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }

  function bringIntoView(el) {
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } catch (e) {
        el.scrollIntoView();
      }
    }
  }

  // ------------------------------------------------------------------ virtual mouse

  var overlay = null;
  var pointer = { x: -100, y: -100 };
  var hideTimer = null;
  var reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensureOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;
    var host = document.createElement("div");
    host.setAttribute("data-ataraxia-overlay", "");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    var css = document.createElement("style");
    css.textContent =
      ".cursor{position:fixed;left:0;top:0;width:22px;height:22px;transform:translate(-100px,-100px);transition:transform 420ms cubic-bezier(.22,.8,.3,1),opacity 200ms;opacity:0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}" +
      ".cursor.on{opacity:1}.cursor.fast{transition-duration:120ms}" +
      ".tag{position:fixed;left:0;top:0;padding:3px 8px;border-radius:999px;font:600 11px/1.4 -apple-system,system-ui,sans-serif;color:#fff;background:#4f46e5;transform:translate(-100px,-100px);transition:transform 420ms cubic-bezier(.22,.8,.3,1),opacity 200ms;opacity:0;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}" +
      ".tag.on{opacity:1}.tag.fast{transition-duration:120ms}" +
      ".ring{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #4f46e5;opacity:0;transform:scale(.3)}" +
      ".ring.go{animation:ring 520ms ease-out}@keyframes ring{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(1.5)}}" +
      ".box{position:fixed;border:2px solid #4f46e5;border-radius:4px;background:rgba(79,70,229,.08);opacity:0;transition:opacity 150ms}.box.on{opacity:1}" +
      ".edge{position:fixed;inset:0;box-shadow:inset 0 0 0 2px rgba(79,70,229,.85),inset 0 0 28px rgba(79,70,229,.35);opacity:0;transition:opacity 250ms}.edge.on{opacity:1}" +
      "@media (prefers-reduced-motion:reduce){.cursor,.tag{transition-duration:1ms}.ring.go{animation-duration:1ms}}";
    var cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 7.5-6 1.6-2.6 6z" fill="#4f46e5" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    var tag = document.createElement("div");
    tag.className = "tag";
    var ring = document.createElement("div");
    ring.className = "ring";
    var box = document.createElement("div");
    box.className = "box";
    var edge = document.createElement("div");
    edge.className = "edge";
    [css, edge, box, ring, cursor, tag].forEach(function (node) { root.appendChild(node); });
    (document.documentElement || document.body).appendChild(host);
    overlay = { host: host, cursor: cursor, tag: tag, ring: ring, box: box, edge: edge };
    return overlay;
  }

  function sleep(ms) {
    return new Promise(function (done) { setTimeout(done, ms); });
  }

  function place(node, x, y, dx, dy) {
    node.style.transform = "translate(" + Math.round(x + dx) + "px," + Math.round(y + dy) + "px)";
  }

  /** Slides the virtual mouse to a point, saying what for, and waits for it to arrive. */
  function moveTo(x, y, caption) {
    var o = ensureOverlay();
    var distance = Math.hypot(x - pointer.x, y - pointer.y);
    var jump = pointer.x < 0 || reduced;
    o.cursor.classList.toggle("fast", jump);
    o.tag.classList.toggle("fast", jump);
    o.cursor.classList.add("on");
    o.edge.classList.add("on");
    place(o.cursor, x, y, -3, -2);
    if (caption) {
      o.tag.textContent = caption;
      o.tag.classList.add("on");
      place(o.tag, x, y, 16, 14);
    } else {
      o.tag.classList.remove("on");
    }
    pointer = { x: x, y: y };
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      o.cursor.classList.remove("on");
      o.tag.classList.remove("on");
      o.edge.classList.remove("on");
      o.box.classList.remove("on");
    }, 3000);
    return sleep(jump ? 30 : Math.min(460, 140 + distance * 0.35));
  }

  function pulse() {
    var o = ensureOverlay();
    o.ring.style.left = pointer.x + "px";
    o.ring.style.top = pointer.y + "px";
    o.ring.classList.remove("go");
    void o.ring.offsetWidth;
    o.ring.classList.add("go");
  }

  function outline(el) {
    var o = ensureOverlay();
    var rect = el.getBoundingClientRect();
    o.box.style.left = rect.left - 2 + "px";
    o.box.style.top = rect.top - 2 + "px";
    o.box.style.width = rect.width + 4 + "px";
    o.box.style.height = rect.height + 4 + "px";
    o.box.classList.add("on");
  }

  function pointerTarget(point) {
    var below = document.elementFromPoint ? document.elementFromPoint(point.x, point.y) : null;
    return below;
  }

  // ------------------------------------------------------------------ actions

  function mouse(el, type, point, extra) {
    var init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: point.x, clientY: point.y, screenX: point.x, screenY: point.y,
      button: 0, buttons: type === "mousedown" || type === "pointerdown" ? 1 : 0, detail: 1,
    };
    if (extra) Object.keys(extra).forEach(function (key) { init[key] = extra[key]; });
    var Kind = /^pointer/.test(type) && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    if (/^pointer/.test(type)) {
      init.pointerId = 1;
      init.pointerType = "mouse";
      init.isPrimary = true;
    }
    return el.dispatchEvent(new Kind(type, init));
  }

  function describeTarget(el) {
    var role = roleOf(el);
    var name = nameOf(el);
    return (role || el.tagName.toLowerCase()) + (name ? " " + JSON.stringify(clip(name, 40)) : "");
  }

  /** Moves the mouse to the element and checks that the click would reach it. */
  function aim(target, verb, options) {
    var resolved = resolve(target);
    if (resolved.point) {
      return moveTo(resolved.point.x, resolved.point.y, verb).then(function () {
        var below = pointerTarget(resolved.point) || document.body;
        return { el: below, point: resolved.point };
      });
    }
    var el = resolved.el;
    bringIntoView(el);
    var point = centre(el);
    var label = verb + " " + describeTarget(el);
    return moveTo(point.x, point.y, label).then(function () {
      outline(el);
      var below = pointerTarget(point);
      if (below && below !== el && !el.contains(below) && !below.contains(el) && !(options && options.force)) {
        var shadowHost = below.getRootNode && below.getRootNode().host;
        if (!shadowHost || !(el === shadowHost || el.contains(shadowHost))) {
          throw new Error(describeTarget(el) + " is covered by " + describe(below) + (below.innerText ? " (" + JSON.stringify(textOf(below, 40)) + ")" : "") + ": close what covers it, scroll, or pass force");
        }
      }
      return { el: el, point: point, below: below };
    });
  }

  function click(command) {
    var count = command.count || 1;
    var button = command.button === "right" ? 2 : 0;
    return aim(command.target, command.count === 2 ? "double-click" : button ? "right-click" : "click", command).then(function (hit) {
      var el = hit.el;
      var point = hit.point;
      var aimAt = hit.below && hit.below !== el && el.contains(hit.below) ? hit.below : el;
      if (el.disabled) throw new Error(describeTarget(el) + " is disabled");
      mouse(aimAt, "pointerover", point);
      mouse(aimAt, "mouseover", point);
      mouse(aimAt, "pointermove", point);
      mouse(aimAt, "mousemove", point);
      for (var i = 0; i < count; i++) {
        mouse(aimAt, "pointerdown", point, { button: button, detail: i + 1 });
        mouse(aimAt, "mousedown", point, { button: button, detail: i + 1 });
        if (typeof el.focus === "function" && roleOf(el) !== "link") {
          try {
            el.focus({ preventScroll: true });
          } catch (e) {
            el.focus();
          }
        }
        mouse(aimAt, "pointerup", point, { button: button, detail: i + 1 });
        mouse(aimAt, "mouseup", point, { button: button, detail: i + 1 });
        if (button === 2) {
          mouse(aimAt, "contextmenu", point, { button: 2 });
        } else if (aimAt.closest && aimAt.closest("a[href]") && typeof aimAt.click === "function") {
          // WebKit does not follow a link for a click that was dispatched; the element's own
          // click() does, and the page's listeners still see a click.
          aimAt.click();
        } else {
          mouse(aimAt, "click", point, { detail: i + 1 });
        }
      }
      if (count === 2) mouse(aimAt, "dblclick", point, { detail: 2 });
      pulse();
      return { clicked: describeTarget(el), at: point, url: location.href };
    });
  }

  function hover(command) {
    return aim(command.target, "hover", command).then(function (hit) {
      var point = hit.point;
      ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove"].forEach(function (type) { mouse(hit.el, type, point); });
      return { hovered: describeTarget(hit.el), at: point };
    });
  }

  var nativeValue = {};
  function setValue(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var key = proto === HTMLTextAreaElement.prototype ? "ta" : proto === HTMLSelectElement.prototype ? "sel" : "in";
    nativeValue[key] = nativeValue[key] || Object.getOwnPropertyDescriptor(proto, "value");
    if (nativeValue[key] && nativeValue[key].set) nativeValue[key].set.call(el, value);
    else el.value = value;
  }

  function inputEvent(el, type, data, inputType) {
    var Kind = typeof InputEvent === "function" ? InputEvent : Event;
    return el.dispatchEvent(new Kind(type, { bubbles: true, cancelable: type === "beforeinput", composed: true, data: data, inputType: inputType || "insertText" }));
  }

  function key(el, type, name, mods) {
    var init = { bubbles: true, cancelable: true, composed: true, key: name, code: codeOf(name), view: window };
    if (mods) Object.keys(mods).forEach(function (k) { init[k] = mods[k]; });
    return el.dispatchEvent(new KeyboardEvent(type, init));
  }

  function codeOf(name) {
    if (/^[a-z]$/i.test(name)) return "Key" + name.toUpperCase();
    if (/^[0-9]$/.test(name)) return "Digit" + name;
    if (name === " ") return "Space";
    return name;
  }

  function writable(el) {
    var tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function typeInto(el, text, replace, slow) {
    el.focus();
    if (el.isContentEditable && !("value" in el)) {
      if (replace) {
        var range = document.createRange();
        range.selectNodeContents(el);
        var selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (!document.execCommand || !document.execCommand("insertText", false, text)) {
        el.textContent = replace ? text : el.textContent + text;
        inputEvent(el, "input", text);
      }
      return Promise.resolve();
    }
    if (replace && el.value) {
      setValue(el, "");
      inputEvent(el, "input", null, "deleteContentBackward");
    }
    var chars = Array.from(text);
    var index = 0;
    function one() {
      if (index >= chars.length) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return Promise.resolve();
      }
      var ch = chars[index++];
      key(el, "keydown", ch);
      key(el, "keypress", ch);
      if (inputEvent(el, "beforeinput", ch)) {
        setValue(el, el.value + ch);
        inputEvent(el, "input", ch);
      }
      key(el, "keyup", ch);
      return slow ? sleep(18).then(one) : one();
    }
    return one();
  }

  function fillValue(el, text) {
    el.focus();
    if (el.isContentEditable && !("value" in el)) return typeInto(el, text, true, false);
    setValue(el, text);
    inputEvent(el, "input", text);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return Promise.resolve();
  }

  function type(command, fill) {
    var text = command.text === undefined ? "" : String(command.text);
    return aim(command.target, fill ? "fill" : "type into", command).then(function (hit) {
      var el = hit.el;
      if (!writable(el)) {
        var inner = el.querySelector && el.querySelector("input,textarea,[contenteditable='true']");
        if (!inner) throw new Error(describeTarget(el) + " is not something text can be typed into");
        el = inner;
      }
      if (el.disabled || el.readOnly) throw new Error(describeTarget(el) + " is disabled or read-only");
      mouse(el, "mousedown", hit.point);
      mouse(el, "mouseup", hit.point);
      mouse(el, "click", hit.point);
      var done = fill ? fillValue(el, text) : typeInto(el, text, command.clear !== false && !command.append, text.length <= 80);
      return done.then(function () {
        var result = { typed: text.length + " characters", into: describeTarget(el) };
        if (command.submit) {
          return press({ key: "Enter" }).then(function (pressed) {
            result.submitted = true;
            return result;
          });
        }
        return result;
      });
    });
  }

  function tabbable() {
    return allVisible("a[href],button,input,select,textarea,summary,[tabindex]").filter(function (el) {
      return !el.disabled && el.tabIndex >= 0 && !(el.type === "hidden");
    });
  }

  function press(command) {
    var combo = String(command.key || "").split("+");
    var name = combo.pop() || "+";
    var mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    combo.forEach(function (mod) {
      var m = mod.toLowerCase();
      if (m === "ctrl" || m === "control") mods.ctrlKey = true;
      else if (m === "shift") mods.shiftKey = true;
      else if (m === "alt" || m === "option") mods.altKey = true;
      else if (m === "meta" || m === "cmd" || m === "command" || m === "super") mods.metaKey = true;
    });
    var aliases = { esc: "Escape", return: "Enter", del: "Delete", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };
    name = aliases[name.toLowerCase()] || name;
    var step = command.target ? aim(command.target, "focus", command).then(function (hit) { try { hit.el.focus(); } catch (e) { /* not focusable */ } return hit.el; }) : Promise.resolve(document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);
    return step.then(function (el) {
      var allowed = key(el, "keydown", name, mods);
      var printable = name.length === 1 && !mods.ctrlKey && !mods.metaKey;
      if (allowed) {
        var tag = el.tagName.toLowerCase();
        if (printable) {
          key(el, "keypress", name, mods);
          if (name !== " " || writable(el)) {
            if (writable(el) && !el.disabled && !el.readOnly) {
              if (inputEvent(el, "beforeinput", name)) {
                if ("value" in el) setValue(el, el.value + name);
                else document.execCommand && document.execCommand("insertText", false, name);
                inputEvent(el, "input", name);
              }
            }
          }
          if (name === " " && (tag === "button" || (tag === "input" && /^(checkbox|radio|button|submit)$/.test(el.type)))) el.click();
        } else if (name === "Enter") {
          key(el, "keypress", name, mods);
          if (tag === "textarea" || el.isContentEditable) {
            if (tag === "textarea") {
              setValue(el, el.value + "\n");
              inputEvent(el, "input", "\n", "insertLineBreak");
            }
          } else if (tag === "a" || tag === "button" || tag === "summary" || (tag === "input" && /^(button|submit|reset|checkbox|radio)$/.test(el.type))) {
            el.click();
          } else if (tag === "input" && el.form) {
            if (typeof el.form.requestSubmit === "function") el.form.requestSubmit();
            else el.form.submit();
          }
        } else if (name === "Tab") {
          var order = tabbable();
          var at = order.indexOf(el);
          var next = order[(at + (mods.shiftKey ? -1 : 1) + order.length) % order.length];
          if (next) next.focus();
        } else if (name === "Backspace" && writable(el) && "value" in el && !mods.metaKey && !mods.ctrlKey) {
          if (el.value) {
            setValue(el, el.value.slice(0, -1));
            inputEvent(el, "input", null, "deleteContentBackward");
          }
        } else if ((mods.metaKey || mods.ctrlKey) && name.toLowerCase() === "a" && typeof el.select === "function") {
          el.select();
        } else if ((name === "ArrowDown" || name === "ArrowUp") && tag === "select") {
          var idx = el.selectedIndex + (name === "ArrowDown" ? 1 : -1);
          if (idx >= 0 && idx < el.options.length) {
            el.selectedIndex = idx;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
      key(el, "keyup", name, mods);
      return { pressed: command.key, on: describeTarget(el) };
    });
  }

  function select(command) {
    return aim(command.target, "select in", command).then(function (hit) {
      var el = hit.el;
      if (el.tagName.toLowerCase() !== "select") throw new Error(describeTarget(el) + " is not a select");
      var wanted = [].concat(command.values !== undefined ? command.values : command.value);
      var chosen = [];
      Array.prototype.forEach.call(el.options, function (option) {
        var hit = wanted.some(function (w) { return option.value === String(w) || option.text.trim() === String(w); });
        if (hit) chosen.push(option);
      });
      if (chosen.length !== wanted.length) {
        throw new Error("no option " + JSON.stringify(wanted) + " in " + describeTarget(el) + ": options are " + Array.prototype.map.call(el.options, function (o) { return JSON.stringify(o.text.trim()); }).slice(0, 20).join(", "));
      }
      Array.prototype.forEach.call(el.options, function (option) { option.selected = chosen.indexOf(option) !== -1; });
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { selected: chosen.map(function (option) { return option.text.trim(); }) };
    });
  }

  function check(command, on) {
    return aim(command.target, on ? "check" : "uncheck", command).then(function (hit) {
      var el = hit.el;
      if (!("checked" in el)) throw new Error(describeTarget(el) + " is not a checkbox or radio");
      if (el.checked !== on) mouse(el, "click", hit.point);
      return { checked: el.checked, element: describeTarget(el) };
    });
  }

  function scrollContainer(el) {
    for (var node = el; node && node !== document.body; node = node.parentElement) {
      var css = style(node);
      if (css && /(auto|scroll)/.test(css.overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  }

  function scroll(command) {
    var holder = command.target ? resolve(command.target).el : null;
    var box = holder ? scrollContainer(holder) || null : null;
    var dy = typeof command.dy === "number" ? command.dy : 0;
    var dx = typeof command.dx === "number" ? command.dx : 0;
    if (command.to === "bottom") dy = 1e9;
    if (command.to === "top") dy = -1e9;
    if (command.to === "element" && holder) {
      bringIntoView(holder);
    } else if (box && command.target) {
      box.scrollBy(dx, dy);
    } else if (!dy && !dx && !command.to) {
      dy = Math.round(window.innerHeight * 0.85);
      window.scrollBy(0, dy);
    } else {
      window.scrollBy(dx, dy);
    }
    var scroller = box && command.target ? box : null;
    return sleep(60).then(function () {
      var max = scroller ? scroller.scrollHeight - scroller.clientHeight : (document.documentElement.scrollHeight || 0) - window.innerHeight;
      return { scrollY: Math.round(scroller ? scroller.scrollTop : window.scrollY), maxScrollY: Math.max(0, Math.round(max)) };
    });
  }

  function drag(command) {
    return aim(command.from, "drag", command).then(function (from) {
      var transfer = typeof DataTransfer === "function" ? new DataTransfer() : null;
      mouse(from.el, "pointerdown", from.point);
      mouse(from.el, "mousedown", from.point);
      var dragInit = { dataTransfer: transfer };
      var fire = function (el, type, point) {
        var event = new (typeof DragEvent === "function" ? DragEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, dataTransfer: transfer });
        return el.dispatchEvent(event);
      };
      fire(from.el, "dragstart", from.point);
      return aim(command.to, "drop on", command).then(function (to) {
        mouse(to.el, "pointermove", to.point);
        mouse(to.el, "mousemove", to.point);
        fire(to.el, "dragenter", to.point);
        fire(to.el, "dragover", to.point);
        fire(to.el, "drop", to.point);
        fire(from.el, "dragend", to.point);
        mouse(to.el, "pointerup", to.point);
        mouse(to.el, "mouseup", to.point);
        return { dragged: describeTarget(from.el), to: describeTarget(to.el) };
      });
    });
  }

  function waitFor(command) {
    var timeout = Math.min(command.timeout || 10000, 55000);
    var started = Date.now();
    function ready() {
      if (command.text !== undefined && pageText(document.body).indexOf(command.text) === -1) return false;
      if (command.textGone !== undefined && pageText(document.body).indexOf(command.textGone) !== -1) return false;
      if (command.selector !== undefined && !allVisible(command.selector).length) return false;
      if (command.selectorGone !== undefined && allVisible(command.selectorGone).length) return false;
      if (command.url !== undefined && location.href.indexOf(command.url) === -1) return false;
      if (command.idle && (pendingRequests > 0 || Date.now() - lastNetworkActivity < command.idle)) return false;
      if (command.load && document.readyState !== "complete") return false;
      return true;
    }
    var onlyTime = command.text === undefined && command.textGone === undefined && command.selector === undefined && command.selectorGone === undefined && command.url === undefined && !command.idle && !command.load;
    if (onlyTime) return sleep(Math.min(command.ms || 1000, timeout)).then(function () { return { waited: Math.min(command.ms || 1000, timeout) }; });
    return new Promise(function (resolveWait, reject) {
      function tick() {
        if (ready()) return resolveWait({ waited: Date.now() - started, url: location.href });
        if (Date.now() - started > timeout) {
          return reject(new Error("timed out after " + timeout + "ms waiting for " + Object.keys(command).filter(function (k) { return k !== "op" && k !== "timeout"; }).join(", ")));
        }
        setTimeout(tick, 100);
      }
      tick();
    });
  }

  // ------------------------------------------------------------------ reading and inspecting

  function find(command) {
    var hits = [];
    if (command.selector) hits = allVisible(command.selector);
    else if (command.text) hits = byText(command.text, command.role);
    return {
      count: hits.length,
      matches: hits.slice(0, command.limit || 20).map(function (el) {
        return { ref: refOf(el), role: roleOf(el) || el.tagName.toLowerCase(), name: nameOf(el), text: textOf(el, 80), visible: inViewport(el) };
      }),
    };
  }

  function read(command) {
    var root = command.selector ? document.querySelector(command.selector) : document.body;
    if (command.target) root = resolve(command.target).el;
    if (!root) throw new Error("nothing matches " + command.selector);
    var max = command.maxChars || 20000;
    var mode = command.mode || "text";
    if (mode === "text") return { text: clip(pageText(root), max) };
    if (mode === "html") return { html: clip(root.outerHTML, max) };
    if (mode === "links") {
      return {
        links: Array.prototype.slice.call(root.querySelectorAll("a[href]"), 0, 300).filter(visible).map(function (a) {
          return { text: textOf(a, 80), href: absolute(a.getAttribute("href")) };
        }),
      };
    }
    if (mode === "forms") {
      return {
        forms: Array.prototype.map.call(document.forms, function (form) {
          return {
            ref: refOf(form), action: absolute(form.getAttribute("action") || ""), method: (form.method || "get").toUpperCase(),
            fields: Array.prototype.map.call(form.elements, function (field) {
              return { ref: refOf(field), tag: field.tagName.toLowerCase(), type: field.type || "", name: field.name || "", label: nameOf(field), required: !!field.required, value: field.type === "password" ? (field.value ? "••••" : "") : clip(field.value || "", 80) };
            }).slice(0, 80),
          };
        }),
      };
    }
    if (mode === "table") {
      var table = root.tagName.toLowerCase() === "table" ? root : root.querySelector("table");
      if (!table) throw new Error("no table in the page or the element");
      return {
        rows: Array.prototype.slice.call(table.rows, 0, 200).map(function (row) {
          return Array.prototype.map.call(row.cells, function (cell) { return textOf(cell, 120); });
        }),
      };
    }
    throw new Error("unknown read mode " + mode + ": use text, html, links, forms or table");
  }

  var STYLE_PROPS = ["display", "position", "visibility", "opacity", "color", "backgroundColor", "fontSize", "fontWeight", "zIndex", "overflow", "width", "height", "margin", "padding", "cursor", "pointerEvents"];

  function inspect(command) {
    var el = resolve(command.target).el;
    var rect = el.getBoundingClientRect();
    var css = style(el) || {};
    var props = command.styles && command.styles.length ? command.styles : STYLE_PROPS;
    var computed = {};
    props.forEach(function (prop) { computed[prop] = css[prop]; });
    var attrs = {};
    Array.prototype.forEach.call(el.attributes, function (attr) { attrs[attr.name] = clip(attr.value, 200); });
    var path = [];
    for (var node = el; node && node.nodeType === 1 && path.length < 8; node = node.parentElement) path.unshift(describe(node));
    var point = centre(el);
    var top = pointerTarget(point);
    return {
      ref: refOf(el), tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el), path: path.join(" > "),
      box: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible: visible(el), inViewport: inViewport(el), coveredBy: top && top !== el && !el.contains(top) ? describe(top) : null,
      attributes: attrs, styles: computed, text: textOf(el, 200),
    };
  }

  /** Brings an element into view and says where it is, for a picture of just that element. */
  function box(command) {
    var el = resolve(command.target).el;
    bringIntoView(el);
    var rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height), name: describeTarget(el) };
  }

  function storage() {
    function dump(area) {
      var out = {};
      try {
        for (var i = 0; i < area.length && i < 100; i++) {
          var name = area.key(i);
          out[name] = clip(area.getItem(name), 300);
        }
      } catch (e) {
        return "[blocked: " + e.message + "]";
      }
      return out;
    }
    var info = { cookies: document.cookie ? document.cookie.split(/;\s*/).map(function (pair) { var at = pair.indexOf("="); return { name: pair.slice(0, at), value: clip(pair.slice(at + 1), 200) }; }) : [], localStorage: dump(window.localStorage), sessionStorage: dump(window.sessionStorage) };
    var tasks = [];
    if (window.indexedDB && indexedDB.databases) tasks.push(indexedDB.databases().then(function (list) { info.indexedDB = list.map(function (db) { return db.name + " v" + db.version; }); }, function () { info.indexedDB = "[blocked]"; }));
    if (window.caches && caches.keys) tasks.push(caches.keys().then(function (keys) { info.caches = keys; }, function () { info.caches = "[blocked]"; }));
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) tasks.push(navigator.serviceWorker.getRegistrations().then(function (list) { info.serviceWorkers = list.map(function (r) { return r.scope; }); }, function () { info.serviceWorkers = "[blocked]"; }));
    return Promise.all(tasks).then(function () { return info; });
  }

  function performanceInfo() {
    var out = { url: location.href };
    try {
      var nav = performance.getEntriesByType("navigation")[0];
      if (nav) {
        out.navigation = { dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart), connect: Math.round(nav.connectEnd - nav.connectStart), ttfb: Math.round(nav.responseStart - nav.requestStart), response: Math.round(nav.responseEnd - nav.responseStart), domInteractive: Math.round(nav.domInteractive), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), transferSize: nav.transferSize };
      }
      var paints = {};
      performance.getEntriesByType("paint").forEach(function (p) { paints[p.name] = Math.round(p.startTime); });
      out.paint = paints;
      var resources = performance.getEntriesByType("resource");
      out.resources = { count: resources.length, transferBytes: resources.reduce(function (sum, r) { return sum + (r.transferSize || 0); }, 0), slowest: resources.slice().sort(function (a, b) { return b.duration - a.duration; }).slice(0, 5).map(function (r) { return { url: clip(r.name, 120), ms: Math.round(r.duration), type: r.initiatorType }; }) };
    } catch (e) {
      out.note = "timings unavailable: " + e.message;
    }
    if (performance.memory) out.jsHeapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
    out.dom = { nodes: document.getElementsByTagName("*").length, scripts: document.scripts.length };
    return out;
  }

  // ------------------------------------------------------------------ the surface

  var results = {};

  function meta() {
    var icon = document.querySelector("link[rel~='icon'],link[rel='shortcut icon']");
    return {
      pageId: pageId, url: location.href, title: document.title || "", readyState: document.readyState,
      favicon: icon && icon.href ? icon.href : location.origin ? location.origin + "/favicon.ico" : "",
      pending: pendingRequests, scrollY: Math.round(window.scrollY), width: window.innerWidth, height: window.innerHeight,
    };
  }

  function drain(since) {
    since = since || 0;
    function fresh(list) {
      return list.filter(function (entry) { return entry.chg > since; });
    }
    return { pageId: pageId, cursor: counter, console: fresh(logs.console), errors: fresh(logs.errors), net: fresh(logs.net), meta: meta() };
  }

  var OPS = {
    snapshot: function (c) { return snapshot(c); },
    find: find,
    read: read,
    inspect: inspect,
    box: box,
    storage: storage,
    performance: performanceInfo,
    click: click,
    hover: hover,
    type: function (c) { return type(c, false); },
    fill: function (c) { return type(c, true); },
    press: press,
    select: select,
    check: function (c) { return check(c, true); },
    uncheck: function (c) { return check(c, false); },
    scroll: scroll,
    drag: drag,
    wait: waitFor,
  };

  /** Runs one command. The answer is `{done, value|error}`; a pending command is read with poll. */
  /** Results can be nested more deeply than a log line is. */
  function result(value) {
    return plain(value, -4);
  }

  function exec(id, run) {
    var outcome;
    try {
      outcome = run();
    } catch (error) {
      results[id] = { done: true, error: error && error.message ? error.message : String(error) };
      return JSON.stringify(results[id]);
    }
    if (outcome && typeof outcome.then === "function") {
      results[id] = { done: false };
      outcome.then(
        function (value) { results[id] = { done: true, value: result(value) }; },
        function (error) { results[id] = { done: true, error: error && error.message ? error.message : String(error) }; }
      );
      return JSON.stringify({ pending: true });
    }
    results[id] = { done: true, value: result(outcome) };
    return JSON.stringify(results[id]);
  }

  /** A command as the app sends it has a null for everything it did not say: they mean "not given". */
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") {
      var out = {};
      Object.keys(value).forEach(function (key) {
        if (value[key] !== null && value[key] !== undefined) out[key] = clean(value[key]);
      });
      return out;
    }
    return value;
  }

  function run(id, command) {
    command = clean(command);
    return exec(id, function () {
      var op = OPS[command && command.op];
      if (!op) throw new Error("unknown command " + (command && command.op));
      return op(command);
    });
  }

  function poll(id) {
    var found = results[id];
    if (!found) return JSON.stringify({ gone: true });
    if (found.done) delete results[id];
    return JSON.stringify(found);
  }

  var api = { version: VERSION, pageId: pageId, run: run, exec: exec, poll: poll, drain: function (since) { return JSON.stringify(drain(since)); }, meta: function () { return JSON.stringify(meta()); }, plain: plain, ops: Object.keys(OPS) };
  Object.defineProperty(window, "__ataraxia", { value: Object.freeze(api), enumerable: false, configurable: false, writable: false });
})();
