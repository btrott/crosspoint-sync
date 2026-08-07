import type { Connector, HttpTransport } from './types.js';
import { hardcoverConnector } from './hardcover.js';
import { readwiseConnector } from './readwise.js';
import { kosyncConnector } from './kosync.js';
import { bookfusionConnector } from './bookfusion.js';

/** All connectors known to this build. */
const CONNECTORS: Connector[] = [
  kosyncConnector,
  hardcoverConnector,
  readwiseConnector,
  bookfusionConnector,
];

const byId = new Map(CONNECTORS.map((c) => [c.id, c]));

export function listConnectors(): Connector[] {
  return CONNECTORS;
}

export function getConnector(id: string): Connector | undefined {
  return byId.get(id);
}

/** Default transport: the platform fetch, adapted to HttpTransport. */
export const fetchTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, init);
  return {
    status: res.status,
    text: () => res.text(),
    json: () => res.json(),
  };
};
