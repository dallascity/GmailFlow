const bridge = window.gmailflow ?? null;

export const isDesktop = Boolean(bridge?.desktop);
export const apiKey = bridge?.apiKey ?? null;

export class ApiError extends Error {
  constructor(code, params = {}, status = 0) {
    super(code);
    this.code = code;
    this.params = params;
    this.status = status;
  }
}

function headers(extra = {}) {
  return apiKey ? { 'x-api-key': apiKey, ...extra } : extra;
}

export async function request(method, url, body) {
  const init = { method, headers: headers() };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`/api${url}`, init);
  } catch {
    throw new ApiError('network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'request', data.params ?? {}, res.status);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}),
  put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
  upload: (u, file, fields = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', file, file.name);
    return request('POST', u, fd);
  },
};

/** Sunucudan dosya indirir (CSV dışa aktarma). */
export async function download(url, fallbackName = 'export.csv') {
  const res = await fetch(`/api${url}`, { headers: headers() });
  if (!res.ok) throw new ApiError('request', {}, res.status);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Başlık gönderemeyen yerler (img src) için oturum anahtarlı /api adresi. */
export function withKey(url) {
  const full = url.startsWith('/api') ? url : `/api${url}`;
  return apiKey ? `${full}${full.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}` : full;
}

export function eventsUrl() {
  return `/api/events${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
}

export function openExternal(url) {
  if (bridge?.openExternal) return bridge.openExternal(url);
  window.open(url, '_blank', 'noopener');
}

export function openDataDir() {
  return bridge?.openDataDir?.();
}
