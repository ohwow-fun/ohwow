/**
 * Browser → Desktop Escalation Patterns
 *
 * Detects browser error messages that indicate a native OS boundary
 * (file pickers, system dialogs, permission prompts, etc.) where
 * desktop control tools would be more appropriate than browser tools.
 */

const DESKTOP_ESCALATION_PATTERNS = [
  /file.*(upload|picker|dialog)/i,
  /file.*chooser/i,
  /native.*(popup|dialog|window)/i,
  /system.*(dialog|prompt|alert)/i,
  /permission.*prompt/i,
  /save.*as.*dialog/i,
  /print.*dialog/i,
  /open.*with.*app/i,
  /os.*authentication/i,
  /keychain.*prompt/i,
  /security.*dialog/i,
  /download.*dialog/i,
  /certificate.*prompt/i,
];

/**
 * Returns true if the browser error message suggests the task hit a native
 * OS boundary that desktop tools could handle.
 */
export function shouldSuggestDesktopEscalation(errorMessage: string): boolean {
  return DESKTOP_ESCALATION_PATTERNS.some(p => p.test(errorMessage));
}
