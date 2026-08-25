import './starter.js';

const timeout = 15000;

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message ?? `Error HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload.error?.code;
      throw error;
    }
    return { payload, response };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('El servidor no respondió a tiempo.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function get(path) {
  return (await request(path)).payload;
}

export async function post(path, payload = {}, token = null) {
  const id = requestId();
  return (await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...payload, requestId: id }) })).payload;
}

export async function adminGet(path, token) {
  return request(path, { headers: { Authorization: `Bearer ${token}` } });
}
