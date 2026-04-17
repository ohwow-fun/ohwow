/**
 * Central DOM selector registry for YouTube Studio.
 *
 * Every selector used by the youtube/ module lives here with a
 * why-comment. When Studio's Polymer DOM shifts (happens a few times a
 * year), fix the string here and every caller picks it up. The
 * selector-audit CLI evaluates each of these against a live Studio tab
 * so drift shows up as a row instead of a silent hang.
 *
 * Naming convention:
 *   - UPLOAD_*        — Create menu + upload wizard selectors
 *   - VISIBILITY_*    — visibility step radios
 *   - META_*          — title/description contenteditable boxes
 *   - WIZARD_*        — step badges / Next / Done
 *   - DIALOG_*        — modal close/discard affordances
 *   - AUTH_*          — login-required / account-chooser indicators
 *   - CHALLENGE_*     — 2FA / consent / captcha signals
 *   - VIDEO_*         — per-video metadata (read-side)
 *   - ANALYTICS_*     — channel analytics dashboard
 *   - CHANNEL_*       — channel identity (handle, id)
 */

export const SEL = {
  // --- Create / upload wizard ---------------------------------------------
  UPLOAD_CREATE_BUTTON: '[aria-label="Create"]',
  // "Upload videos" menu item — we match by text since the id is unstable.
  UPLOAD_MENU_ITEMS: 'tp-yt-paper-item, [role="menuitem"]',
  UPLOAD_FILE_INPUT: 'input[type="file"][name="Filedata"]',
  UPLOAD_DIALOG: 'ytcp-uploads-dialog',
  UPLOAD_DIALOG_CLOSE_BUTTON: '#ytcp-uploads-dialog-close-button button',

  // --- Metadata step ------------------------------------------------------
  META_TITLE_BOX: '#title-textarea #textbox',
  META_DESCRIPTION_BOX: '#description-textarea #textbox',
  // Polymer paper-radio — grouped by the `name` attribute we read in JS.
  META_KIDS_RADIOS: 'tp-yt-paper-radio-button',

  // --- Wizard navigation --------------------------------------------------
  // Note: Studio renders TWO #next-buttons in the DOM tree; only one is
  // `offsetParent !== null` at a time. Callers must filter by visibility.
  WIZARD_NEXT_BUTTON: '#next-button',
  WIZARD_DONE_BUTTON: '#done-button',
  WIZARD_STEP_BADGES: '[id^="step-badge-"]',

  // --- Visibility step (also paper-radio, grouped by name) ----------------
  VISIBILITY_RADIOS: 'tp-yt-paper-radio-button',

  // --- Discard / dismiss confirmations -----------------------------------
  DIALOG_DISCARD_BUTTON: '[aria-label="Discard"], #discard-button button',
  DIALOG_WELCOME_CLOSE: '#welcome-dialog #close-button button',
  DIALOG_PROCESSING_CLOSE:
    'ytcp-prechecks-warning-dialog #close-button button, tp-yt-paper-dialog [aria-label="Close"]',

  // --- Video URL extraction (surfaces in sidebar after upload) -----------
  SHORTS_LINK: 'a[href*="youtube.com/shorts/"]',
  WATCH_LINK: 'a[href*="youtu.be/"], a[href*="youtube.com/watch"]',

  // --- Auth / login-required signals -------------------------------------
  // Studio redirects to these when session is dead; we don't live there
  // normally, so presence is the health signal.
  AUTH_SIGNIN_FORM: 'form[action*="ServiceLogin"], form[action*="signin"]',
  AUTH_ACCOUNT_CHOOSER: '[data-identifier], [aria-label*="Choose an account" i]',

  // --- Challenge indicators ----------------------------------------------
  CHALLENGE_RECAPTCHA_IFRAME: 'iframe[src*="recaptcha"], iframe[src*="/recaptcha/"]',
  CHALLENGE_TWO_FACTOR: 'form[action*="challenge"], [data-challengetype]',
  CHALLENGE_CONSENT_AGREE:
    'button[aria-label*="Accept all" i], form[action*="consent"] button',
  CHALLENGE_VERIFY_ITS_YOU:
    '[data-view-id="IDENTIFIER_VERIFICATION"], form[action*="verifyidentity"]',

  // --- Channel identity (read once from header) --------------------------
  // Studio surfaces the handle in the top-left channel switcher and the
  // channel id in URLs throughout. We read both as a sanity check.
  CHANNEL_HEADER_AVATAR: '#avatar-btn, ytcp-channel-header #avatar',
  CHANNEL_HANDLE_ANCHOR: 'a[href^="/channel/"], a[href^="/@"]',

  // --- Per-video metadata page ------------------------------------------
  // studio.youtube.com/video/{id}/edit
  VIDEO_TITLE_READ: '#title-textarea #textbox',
  VIDEO_DESCRIPTION_READ: '#description-textarea #textbox',
  VIDEO_VISIBILITY_PILL: 'ytcp-video-visibility-select [aria-label]',
  VIDEO_PROCESSING_STATUS: 'ytcp-video-upload-progress, .ytcp-video-upload-progress',
  // The right-side info column has views, likes, comments in <ytcp-video-metrics>.
  VIDEO_METRIC_ROWS: 'ytcp-video-metrics .metric, ytcp-video-metrics ytcp-video-metric',

  // --- Analytics dashboard ----------------------------------------------
  // studio.youtube.com/channel/{id}/analytics/tab-overview/period-*
  ANALYTICS_CARD_VALUES: 'ytcp-card .metric, [role="heading"] + *',
  ANALYTICS_CARD_TITLES: 'ytcp-card [role="heading"], ytcp-metric-card .title',
} as const;

export type SelKey = keyof typeof SEL;
