/**
 * Transport ManageSieve de production : port autorisé (4190), adresses publiques vérifiées puis épinglées
 * (`pinHostCandidates`, SNI et certificat sur le nom d'origine), IPv4 d'abord, TLS implicite ou STARTTLS.
 */
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import type { ImapEndpoint } from '../backend/types.js';
import { assertAllowedPort, pinHostCandidates, tryCandidates } from '../netguard.js';

const CONNECT_TIMEOUT = 10_000;

function once<T extends Duplex>(sock: T, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error('connect timeout'), { code: 'CONNECT_TIMEOUT' }));
    }, CONNECT_TIMEOUT);
    sock.once(event, () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function sieveTransport(ep: ImapEndpoint): { connect: () => Promise<Duplex>; upgrade?: (s: Duplex) => Promise<Duplex> } {
  let servername: string | undefined;
  const connect = async (): Promise<Duplex> => {
    assertAllowedPort('sieve', ep.port);
    const candidates = await pinHostCandidates(ep.host);
    return tryCandidates(candidates, async (c) => {
      servername = c.servername;
      if (ep.secure) return once(tls.connect({ host: c.host, port: ep.port, ...(servername ? { servername } : {}) }), 'secureConnect');
      return once(net.connect({ host: c.host, port: ep.port }), 'connect');
    });
  };
  if (ep.secure) return { connect };
  return {
    connect,
    upgrade: (socket) => once(tls.connect({ socket: socket as net.Socket, ...(servername ? { servername } : {}) }), 'secureConnect'),
  };
}
