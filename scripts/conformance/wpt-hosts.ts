// WPT's hosts, on the loopback where wptserve listens. `web-platform.test` and
// its subdomains resolve here with nothing on the machine changed. A module of
// its own, since a thread has a resolver of its own: the harness imports it,
// and hands its URL to the network for the thread that makes synchronous
// requests (`HtmlNetworkOptions.threadSetup`).
import dns from 'node:dns';

const lookup = dns.lookup;
const ours = /(^|\.)(not-)?web-platform\.test$/i;
(dns as { lookup: unknown }).lookup = function (
  host: string,
  options: unknown,
  callback?: (...args: unknown[]) => void,
) {
  const cb = (typeof options === 'function' ? options : callback) as (
    ...args: unknown[]
  ) => void;
  const opts = (typeof options === 'object' && options) || {};
  if (ours.test(host)) {
    if ((opts as { all?: boolean }).all) {
      process.nextTick(cb, null, [{ address: '127.0.0.1', family: 4 }]);
    } else process.nextTick(cb, null, '127.0.0.1', 4);
    return;
  }
  return (lookup as (...a: unknown[]) => unknown).call(
    dns,
    host,
    options,
    callback,
  );
};
