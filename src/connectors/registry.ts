import type { Connector, HttpTransport } from './types.js';
import { hardcoverConnector } from './hardcover.js';
import { readwiseConnector } from './readwise.js';

/** All connectors known to this build. Tier 2/3 are added here as they land. */
const CONNECTORS: Connector[] = [hardcoverConnector, readwiseConnector];

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
