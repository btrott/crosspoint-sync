/**
 * Rich reading position - 1:1 with the firmware's CompactPosition wire struct
 * (see CrossInk NearbyBookPositionSyncActivity.h). Page fields are layout hints;
 * pctQ / para / anchor / xpath are the portable parts.
 */
export interface RichPosition {
  /** Percentage quantized to 0..1,000,000. */
  pctQ: number;
  spine: number;
  page: number;
  pages: number;
  para?: number;
  li?: number;
  anchor?: string;
  xpath?: string;
}

const MAX_ANCHOR_BYTES = 48;
const MAX_XPATH_BYTES = 120;

function isUint(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/** Validates and normalizes a client-sent position object. Returns null if invalid. */
export function parsePosition(raw: unknown): RichPosition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isUint(o.pctQ, 1_000_000)) return null;
  if (!isUint(o.spine, 65_535) || !isUint(o.page, 65_535) || !isUint(o.pages, 65_535)) {
    return null;
  }
  const pos: RichPosition = {
    pctQ: o.pctQ,
    spine: o.spine,
    page: o.page,
    pages: o.pages,
  };
  if (o.para !== undefined) {
    if (!isUint(o.para, 65_535)) return null;
    pos.para = o.para;
  }
  if (o.li !== undefined) {
    if (!isUint(o.li, 65_535)) return null;
    pos.li = o.li;
  }
  if (o.anchor !== undefined) {
    if (typeof o.anchor !== 'string' || Buffer.byteLength(o.anchor) > MAX_ANCHOR_BYTES) return null;
    pos.anchor = o.anchor;
  }
  if (o.xpath !== undefined) {
    if (typeof o.xpath !== 'string' || Buffer.byteLength(o.xpath) > MAX_XPATH_BYTES) return null;
    pos.xpath = o.xpath;
  }
  return pos;
}
