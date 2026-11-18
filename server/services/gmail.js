const SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

export class GmailError extends Error {
  /**
   * kind: 'quota' (günlük limit) · 'rate' (kısa süreli hız sınırı) · 'auth' · 'recipient' · 'transient' · 'fatal'
   */
  constructor({ kind, status, reason, message, retryAt = null }) {
    super(message || reason || `HTTP ${status}`);
    this.kind = kind;
    this.status = status;
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

/** Gmail API'sine ham (RFC 822) mesajı gönderir. */
export async function sendRawMessage(accessToken, raw, { fetchImpl = fetch, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'message/rfc822' },
      body: raw,
      signal,
    });
  } catch (err) {
    throw new GmailError({ kind: 'transient', status: 0, reason: 'network', message: err?.cause?.code ?? err.message });
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { id: body.id, threadId: body.threadId };
  throw classifyError(res.status, body);
}

export function classifyError(status, body) {
  const err = body?.error ?? {};
  const reason = err.errors?.[0]?.reason ?? err.status ?? '';
  const message = err.message ?? '';
  const retryMatch = /Retry after (\S+)/i.exec(message);
  const retryAt = retryMatch ? new Date(retryMatch[1]) : null;
  const base = { status, reason, message };

  if (status === 401) return new GmailError({ ...base, kind: 'auth' });
  if (/dailyLimitExceeded|quotaExceeded/i.test(reason) || /sending limit|daily user sending/i.test(message)) {
    return new GmailError({ ...base, kind: 'quota', retryAt });
  }
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded/i.test(reason)) {
    // "Retry after" uzak bir zamansa bu fiilen günlük kotadır.
    const far = retryAt && !Number.isNaN(+retryAt) && retryAt - Date.now() > 2 * 60 * 1000;
    return new GmailError({ ...base, kind: far ? 'quota' : 'rate', retryAt });
  }
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason + message)) {
    return new GmailError({ ...base, kind: 'auth' });
  }
  if (status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason + message)) {
    return new GmailError({ ...base, kind: 'fatal', reason: 'api_disabled' });
  }
  if (status === 400) return new GmailError({ ...base, kind: 'recipient' });
  if (status >= 500) return new GmailError({ ...base, kind: 'transient' });
  return new GmailError({ ...base, kind: 'fatal' });
}
