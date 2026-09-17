import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAMBER_RUNTIME_PROTOCOL, defaultDaemonOrigin, serverDaemonOrigin } from './daemon-origin';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const install = (value: unknown) => vi.stubGlobal('__JEVYR_CHAMBER_CONFIG__', value);
const documentWith = (values: string[]) => vi.stubGlobal('document', { querySelectorAll: () => values.map(value => ({ getAttribute: () => value })) });

describe('public production daemon configuration', () => {
  it.each(['http://127.0.0.1:19371', 'http://localhost:4319', 'http://[::1]:4400'])('preserves %s through server rendering and browser hydration', origin => {
    install(Object.freeze({ protocol: CHAMBER_RUNTIME_PROTOCOL, daemonOrigin: origin }));
    expect(serverDaemonOrigin()).toBe(origin);
    documentWith([serverDaemonOrigin()]);
    expect(defaultDaemonOrigin()).toBe(origin);
  });
  it('keeps a standalone local default while ignoring compiled or ambient NEXT_PUBLIC values', () => {
    vi.stubEnv('NEXT_PUBLIC_JEVYR_API', 'http://example.org:9999');
    expect(serverDaemonOrigin()).toBe('http://127.0.0.1:4317');
    documentWith([]);
    expect(defaultDaemonOrigin()).toBe('http://127.0.0.1:4317');
  });
  it.each(['https://127.0.0.1:443', 'http://example.org', 'http://user:secret@localhost:4317', 'http://localhost:4317/path', 'http://localhost:4317?token=secret', 'http://localhost:4317#fragment'])('refuses unsafe startup origin %s rather than silently routing elsewhere', value => {
    install({ protocol: CHAMBER_RUNTIME_PROTOCOL, daemonOrigin: value });
    expect(serverDaemonOrigin).toThrow(); documentWith([value]); expect(defaultDaemonOrigin).toThrow();
  });
  it('refuses unknown fields, protocol substitution, accessor configuration and ambiguous metadata', () => {
    install({ protocol: CHAMBER_RUNTIME_PROTOCOL, daemonOrigin: 'http://localhost:4317', token: 'not-public' }); expect(serverDaemonOrigin).toThrow();
    install({ protocol: 'unknown', daemonOrigin: 'http://localhost:4317' }); expect(serverDaemonOrigin).toThrow();
    const getter = vi.fn(() => 'http://localhost:4317');
    install({ protocol: CHAMBER_RUNTIME_PROTOCOL, get daemonOrigin() { return getter(); } }); expect(serverDaemonOrigin).toThrow(); expect(getter).not.toHaveBeenCalled();
    documentWith(['http://localhost:4317', 'http://localhost:4318']); expect(defaultDaemonOrigin).toThrow();
  });
});
