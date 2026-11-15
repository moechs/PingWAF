import i18n from '@/i18n'
import { ApiError } from '@/api/client'

/**
 * Stable backend error codes → localized console copy (UX-05).
 *
 * The control plane returns a machine-readable `error.code` next to the
 * human-readable `error.message`. The message is written for operators reading
 * logs and stays English; the console maps the code to a translated message so
 * a zh/ja UI never shows a raw English sentence.
 *
 * Only codes that have a dedicated key here are translated. Everything else
 * keeps the server message, which is still the most specific description
 * available for one-off validation failures.
 */
const CODE_KEYS: Record<string, string> = {
  // Namespaced codes (v0.32.27+).
  'auth.invalid_credentials': 'errors.invalidCredentials',
  'site.domain_conflict': 'errors.domainConflict',
  'validation.expression_invalid': 'errors.expressionInvalid',
  // Un-namespaced aliases: older control planes and the pre-code strings that
  // some handlers still attach, so a mixed-version deployment degrades to the
  // same localized copy instead of English.
  invalid_credentials: 'errors.invalidCredentials',
  domain_conflict: 'errors.domainConflict',
  expression_invalid: 'errors.expressionInvalid',
}

/**
 * Localized message for a backend error code, or `null` when the code has no
 * mapping (caller falls back to the server message).
 */
export function messageForErrorCode(
  code: string | null | undefined,
): string | null {
  if (!code) return null
  const key = CODE_KEYS[code]
  if (!key) return null
  const value = i18n.t(key)
  return typeof value === 'string' && value !== key ? value : null
}

/**
 * Best message to show for a thrown value: the localized copy for a known
 * backend code, then the server/JS message, then the caller's fallback.
 */
export function localizedErrorMessage(
  err: unknown,
  fallback = '',
): string {
  if (err instanceof ApiError) {
    const localized = messageForErrorCode(err.code)
    if (localized) return localized
    return err.message || fallback
  }
  if (err instanceof Error) return err.message || fallback
  return fallback || String(err ?? '')
}

/**
 * True when `err` is the backend's "this domain is already used by another
 * site" failure. The code is authoritative; the message test keeps older
 * control planes (and the clone dialog's original heuristic) working.
 */
export function isDomainConflictError(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.code === 'site.domain_conflict' || err.code === 'domain_conflict') {
      return true
    }
    return /already in use by another site|domain.*conflict/i.test(
      err.message || '',
    )
  }
  return false
}