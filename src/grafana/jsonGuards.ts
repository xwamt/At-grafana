export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a Grafana object reference that has been spelled two ways across
 * versions: a string `uid` since Grafana 9, and a numeric auto-increment `id`
 * before it (`folderUid` vs `folderId` on `/api/search` entries and on the
 * ruler API's groups, `uid` vs `id` on `/api/folders`).
 *
 * Both are tried so an older instance still groups its dashboards, and the
 * new spelling wins when an instance sends both.
 *
 * `0` is not a folder. Pre-9 Grafana uses `folderId: 0` to mean the General
 * (folderless) bucket, so reading it as a reference would file every
 * folderless dashboard under a folder that does not exist -- which renders as
 * "the dashboard vanished," strictly worse than the missing folder this
 * fallback exists to fix.
 */
export function readUidOrLegacyId(uid: unknown, legacyId: unknown): string | undefined {
  if (typeof uid === 'string' && uid.length > 0) {
    return uid;
  }
  if (typeof legacyId === 'number' && Number.isInteger(legacyId) && legacyId > 0) {
    return String(legacyId);
  }
  if (typeof legacyId === 'string' && legacyId.length > 0 && legacyId !== '0') {
    return legacyId;
  }
  return undefined;
}

export function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}
