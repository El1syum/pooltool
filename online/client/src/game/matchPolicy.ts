/** Cosmetic preferences never override a server-owned match rule. */
export interface MatchPolicyContext {
  ranked?: boolean
  status?: string
}

export interface AimGuidePolicy {
  locked: boolean
  forcedValue: boolean | null
  reason: string | null
}

// Kept in one place while the platform's ranked presentation is configured.
export const RANKED_AIM_GUIDE_VALUE = false
export const RANKED_AIM_GUIDE_REASON = 'В рейтинговом матче линия прицеливания отключена для всех игроков.'

/**
 * A ranked match remains locked while active, calculating or reconnecting.
 * Unknown intermediate statuses fail closed; a confirmed finish restores the
 * personal preference. The caller passes the authoritative API match, not room
 * settings, a queue choice or a value from personal/local settings.
 */
export function getAimGuidePolicy(match: MatchPolicyContext | null | undefined): AimGuidePolicy {
  const locked = match?.ranked === true && match.status !== 'finished'
  return {
    locked,
    forcedValue: locked ? RANKED_AIM_GUIDE_VALUE : null,
    reason: locked ? RANKED_AIM_GUIDE_REASON : null,
  }
}

export function effectiveAimGuide(preference: boolean, match: MatchPolicyContext | null | undefined): boolean {
  return getAimGuidePolicy(match).forcedValue ?? preference
}

/** A render-only copy: never persist this derived value over casual settings. */
export function applyMatchVisualPolicy<T extends { showAimGuide: boolean }>(settings: T, match: MatchPolicyContext | null | undefined): Omit<T, 'showAimGuide'> & { showAimGuide: boolean } {
  return { ...settings, showAimGuide: effectiveAimGuide(settings.showAimGuide, match) }
}
