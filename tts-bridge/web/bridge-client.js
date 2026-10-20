// All participant HTTP, audio and WebSocket URLs pass through this transport.
// Chatter can configure a Bridge URL and token without changing the views.
export class BridgeClient {
  constructor({
    baseUrl = /^https?:$/.test(globalThis.location?.protocol)
      ? globalThis.location.origin
      : "http://127.0.0.1",
    token,
    fetchImpl = (...args) => globalThis.fetch(...args),
  } = {}) {
    this.baseUrl = new URL(baseUrl).origin;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.controller = new AbortController();
  }
  url(path) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl)
      throw new Error("別の接続先への通信はできません");
    return url;
  }
  async request(
    path,
    { method = "GET", body, key, signal, timeout = 15000 } = {},
  ) {
    const response = await this.fetchImpl(this.url(path), {
      method,
      credentials: this.token ? "omit" : "same-origin",
      redirect: "error",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(this.extensionOrigin
          ? { "X-Chatter-Origin": this.extensionOrigin }
          : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(timeout),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(
        new Error(data.error ?? `通信に失敗しました（${response.status}）`),
        { status: response.status },
      );
    }
    return response;
  }
  async json(path, options) {
    return (await this.request(path, options)).json();
  }
  room(roomId, path) {
    return `/api/v1/rooms/${encodeURIComponent(roomId)}/${path}`;
  }
  socket() {
    const url = this.url("/ws");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url);
  }
  cancel() {
    this.controller.abort();
    this.controller = new AbortController();
  }
}
export const bridge = new BridgeClient();
