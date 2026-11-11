/** Private profile fields; the public nickname remains User.displayName. */
export interface ProfileDetails {
  fullName: string
  city: string
  about: string
}

export const PROFILE_DETAIL_LIMITS = { fullName: 64, city: 64, about: 300 } as const

export function emptyProfileDetails(): ProfileDetails {
  return { fullName: '', city: '', about: '' }
}

// Remove invisible controls (including bidi overrides), but keep joiners used
// by real writing systems and emoji. Keep line breaks in the biography only.
const invisibleControls = /[\p{Cc}\p{Cf}\p{Cs}]/gu

export function sanitizeProfileField(field: keyof ProfileDetails, value: unknown, draft = false): string {
  if (typeof value !== 'string') return ''
  const multiline = field === 'about'
  const text = value.normalize('NFC')
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(invisibleControls, character =>
      character === '\u200c' || character === '\u200d' || (multiline && character === '\n') ? character
        : character === '\n' ? ' ' : '')
  // Match native maxlength (UTF-16) without storing half of an emoji.
  const bounded = (draft ? text : text.trim()).slice(0, PROFILE_DETAIL_LIMITS[field]).replace(/[\uD800-\uDBFF]$/, '')
  return draft ? bounded : bounded.trimEnd()
}

export function normalizeProfileDetails(value: unknown): ProfileDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyProfileDetails()
  const record = value as Record<string, unknown>
  return {
    fullName: sanitizeProfileField('fullName', record.fullName),
    city: sanitizeProfileField('city', record.city),
    about: sanitizeProfileField('about', record.about),
  }
}

/** The next numeric 100-Elo milestone, not a league, rank or a mock RP score. */
export function profileRatingMilestone(elo: number) {
  if (!Number.isSafeInteger(elo) || elo < 0 || elo > Number.MAX_SAFE_INTEGER - 100) return null
  const start = Math.floor(elo / 100) * 100
  const target = start + 100
  return { elo, start, target, remaining: target - elo, percent: elo - start }
}
