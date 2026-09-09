export interface JsonCapture {
  readonly url: string
  readonly body: unknown
}

export const captureJsonInitScript = [
  "(() => {",
  "  const w = window;",
  "  if (w.__tenderFinderHooked === true) return;",
  "  w.__tenderFinderHooked = true;",
  "  w.__tenderFinderCaptures = [];",
  "  const push = (url, body) => { w.__tenderFinderCaptures.push({ url, body }); };",
  "  const origFetch = w.fetch.bind(w);",
  "  w.fetch = async (...args) => {",
  "    const res = await origFetch(...args);",
  "    try {",
  "      const ct = res.headers.get('content-type') || '';",
  "      if (ct.includes('json')) push(res.url, await res.clone().json());",
  "    } catch {}",
  "    return res;",
  "  };",
  "  const origOpen = XMLHttpRequest.prototype.open;",
  "  const origSend = XMLHttpRequest.prototype.send;",
  "  XMLHttpRequest.prototype.open = function(method, url, ...rest) {",
  "    this.__tfUrl = typeof url === 'string' ? url : String(url);",
  "    return origOpen.call(this, method, url, ...rest);",
  "  };",
  "  XMLHttpRequest.prototype.send = function(...args) {",
  "    this.addEventListener('load', () => {",
  "      try {",
  "        const ct = this.getResponseHeader('content-type') || '';",
  "        if (ct.includes('json') && this.responseText) {",
  "          push(this.__tfUrl || '', JSON.parse(this.responseText));",
  "        }",
  "      } catch {}",
  "    });",
  "    return origSend.apply(this, args);",
  "  };",
  "})();",
].join("\n")

export const peekJsonCapturesSource = [
  "(() => {",
  "  const w = window;",
  "  return Array.isArray(w.__tenderFinderCaptures) ? [...w.__tenderFinderCaptures] : [];",
  "})()",
].join("\n")

export const drainJsonCapturesSource = [
  "(() => {",
  "  const w = window;",
  "  const items = Array.isArray(w.__tenderFinderCaptures) ? w.__tenderFinderCaptures : [];",
  "  w.__tenderFinderCaptures = [];",
  "  return items;",
  "})()",
].join("\n")
