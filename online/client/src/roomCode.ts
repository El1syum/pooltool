/** Invite codes contain six uppercase ASCII letters/digits, never lookalikes. */
export function isRoomCode(value: string) {
  return value.length === 6 && /^[A-Z0-9]{6}$/.test(value)
}

export function normalizeRoomCode(value: string) {
  // Strip non-ASCII before uppercasing: ß and Unicode lookalikes are not code letters.
  return value.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()
}
