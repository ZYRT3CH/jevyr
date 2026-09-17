/** Public connection configuration, never a credential or evidence authority. */
export const CHAMBER_RUNTIME_PROTOCOL = 'jevyr.chamber-runtime/1';
export const DAEMON_ORIGIN_META = 'jevyr-daemon-origin';
const DEFAULT_ORIGIN = 'http://127.0.0.1:4317';

function loopbackOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) throw new TypeError('Invalid Chamber daemon origin');
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Chamber startup requires a public loopback HTTP origin without credentials');
  }
  return url.origin;
}

/** The local production launcher sets this before loading server modules.
 * Standalone development retains the default; runtime values are not inlined. */
export function serverDaemonOrigin(): string {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__JEVYR_CHAMBER_CONFIG__');
  if (!descriptor) return DEFAULT_ORIGIN;
  if (!('value' in descriptor)) throw new TypeError('Chamber runtime configuration cannot be an accessor');
  const value: unknown = descriptor.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid Chamber runtime configuration');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).sort().join(',') !== 'daemonOrigin,protocol'
    || !('value' in fields.protocol) || !('value' in fields.daemonOrigin)
    || fields.protocol.value !== CHAMBER_RUNTIME_PROTOCOL) throw new TypeError('Invalid Chamber runtime configuration fields');
  return loopbackOrigin(fields.daemonOrigin.value);
}

/** RootLayout emits this metadata before browser modules execute. Reading the
 * same value in SSR and hydration preserves custom ports across all routes. */
export function defaultDaemonOrigin(): string {
  if (typeof document === 'undefined') return serverDaemonOrigin();
  const entries = document.querySelectorAll(`meta[name="${DAEMON_ORIGIN_META}"]`);
  if (entries.length === 0) return DEFAULT_ORIGIN;
  if (entries.length !== 1) throw new TypeError('Chamber daemon origin metadata is ambiguous');
  return loopbackOrigin(entries[0].getAttribute('content'));
}
