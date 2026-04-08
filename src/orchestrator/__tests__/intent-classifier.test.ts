import { describe, it, expect } from 'vitest';
import { classifyIntent, CONFIRMATION_PATTERN } from '../intent-classifier.js';

describe('classifyIntent', () => {
  // ── Greeting ──
  it('"hey" → greeting, conversational', () => {
    const r = classifyIntent('hey');
    expect(r.intent).toBe('greeting');
    expect(r.mode).toBe('conversational');
  });
  it('"good morning" → greeting', () => expect(classifyIntent('good morning').intent).toBe('greeting'));
  it('"HELLO" → greeting (case insensitive)', () => expect(classifyIntent('HELLO').intent).toBe('greeting'));

  // ── Confirmation ──
  it('"yes" inherits previous intent', () => {
    const prev = classifyIntent('research competitor pricing');
    const r = classifyIntent('yes', prev);
    expect(r.intent).toBe(prev.intent);
    expect(r.sections).toBe(prev.sections);
    expect(r.mode).toBe('execute');
  });
  it('"go ahead" matches CONFIRMATION_PATTERN', () => expect(CONFIRMATION_PATTERN.test('go ahead')).toBe(true));

  // ── Desktop (24 test cases) ──
  describe('desktop intent', () => {
    const desktopCases = [
      'Open TextEdit, create a new document, then use typewrite mode to type the quick brown fox',
      'Open Safari and navigate to apple.com. Then switch to Finder using cmd+tab',
      'Open Finder and resize the window by dragging its bottom-right corner',
      'Open Safari and go to wikipedia. Scroll down slowly through the article',
      'Open 1Password. Then close it with cmd+w. Next open Notes',
      'Take a screenshot and tell me what apps are open',
      'Move the cursor to the top left corner and click',
      'Drag the file from Downloads to the Desktop',
      'Press enter on the dialog box',
      'Scroll down in the current window',
      'Close this window and open a new one',
      'Resize the Chrome window to fill the left half',
      'Type my email address into the login form',
      'Right-click on the icon in the dock',
      'Double-click on the folder to open it',
      'Use keyboard shortcut to switch between windows',
      'Minimize all windows and show the desktop',
      'Take a screenshot of just the second monitor',
      'Open the app switcher and close Safari',
      'Navigate through System Settings to change the wallpaper',
      'Fill out the registration form in Chrome with my info',
      'Open Spotlight and search for Calculator',
      'Copy the text from this PDF and paste it in Notes',
      'Click the red close button on the window',
    ];

    for (const msg of desktopCases) {
      it(`"${msg.slice(0, 55)}..." → desktop`, () => {
        expect(classifyIntent(msg).intent).toBe('desktop');
      });
    }

    it('has desktop section', () => {
      expect(classifyIntent('click on the button').sections.has('desktop')).toBe(true);
    });
  });

  // ── Browser ──
  describe('browser intent', () => {
    const browserCases = [
      'open the website and check the pricing page',
      'go to google.com and search for restaurants',
      'scrape the product list from that URL',
      'browse the documentation for React hooks',
      'take a screenshot of the web page',
      'open the website in Safari and take a screenshot',
    ];
    for (const msg of browserCases) {
      it(`"${msg.slice(0, 55)}" → browser`, () => {
        expect(classifyIntent(msg).intent).toBe('browser');
      });
    }
  });

  // ── Dev ──
  describe('dev intent', () => {
    const devCases = [
      'fix the bug in the login handler',
      'refactor the authentication module',
      'search the codebase for the login function',
      'add a test for the payment endpoint',
      'run npm test and fix any failures',
      'git commit these changes',
      'implement the new user profile feature',
    ];
    for (const msg of devCases) {
      it(`"${msg.slice(0, 55)}" → dev`, () => {
        expect(classifyIntent(msg).intent).toBe('dev');
      });
    }
  });

  // ── File ──
  describe('file intent', () => {
    const fileCases = [
      'read the config file and show me the settings',
      'edit the README.md to add installation steps',
      'list all .tsx files in the components folder',
      'open the config.json file and edit the port number',
    ];
    for (const msg of fileCases) {
      it(`"${msg.slice(0, 55)}" → file`, () => {
        expect(classifyIntent(msg).intent).toBe('file');
      });
    }
  });

  // ── Message ──
  describe('message intent', () => {
    it('whatsapp message → message', () => expect(classifyIntent('send a whatsapp message to John').intent).toBe('message'));
    it('text [name] → message', () => expect(classifyIntent('text Maria about the meeting').intent).toBe('message'));
    it('telegram message → message', () => expect(classifyIntent('send a message on telegram to the team').intent).toBe('message'));
    it('whatsapp + click keyword → still message', () => {
      expect(classifyIntent('send John a whatsapp message saying click the link').intent).toBe('message');
    });
  });

  // ── Research ──
  it('"research competitor pricing" → research', () => expect(classifyIntent('research competitor pricing').intent).toBe('research'));
  it('"deep research into AI agent frameworks" → research', () => expect(classifyIntent('deep research into AI agent frameworks').intent).toBe('research'));

  // ── Media ──
  it('"generate an image of a sunset" → media', () => expect(classifyIntent('generate an image of a sunset over mountains').intent).toBe('media'));
  it('"create a video presentation" → media', () => expect(classifyIntent('create a video presentation about our product').intent).toBe('media'));

  // ── Task ──
  it('"run the marketing agent" → task', () => expect(classifyIntent('run the marketing agent on the new leads').intent).toBe('task'));
  it('"create a task to update docs" → task', () => expect(classifyIntent('create a task to update the documentation').intent).toBe('task'));

  // ── CRM ──
  it('"find the lead" → crm', () => expect(classifyIntent('find the lead from yesterday').intent).toBe('crm'));
  it('"log a call with customer" → crm', () => expect(classifyIntent('log a call with the customer about renewal').intent).toBe('crm'));

  // ── Status ──
  it('"how are things going" → status, conversational', () => {
    const r = classifyIntent('how are things going with the agents');
    expect(r.intent).toBe('status');
    expect(r.mode).toBe('conversational');
  });
  it('"show me the pulse" → status', () => expect(classifyIntent('show me the pulse and activity overview').intent).toBe('status'));

  // ── Plan ──
  it('"create a strategy for Q2" → plan', () => expect(classifyIntent('create a strategy for Q2').intent).toBe('plan'));

  // ── General fallback ──
  it('random text → general', () => expect(classifyIntent('lorem ipsum dolor sit amet').intent).toBe('general'));
  it('empty → general', () => expect(classifyIntent('   ').intent).toBe('general'));
  it('"what is the meaning of life" → general', () => expect(classifyIntent('what is the meaning of life').intent).toBe('general'));

  // ── Complex pattern detection ──
  it('"set up a multi-step workflow" → planFirst=true', () => {
    expect(classifyIntent('set up a multi-step workflow').planFirst).toBe(true);
  });

  // ── Explore mode ──
  it('"show me the agents" → general, explore mode', () => {
    const r = classifyIntent('show me the agents');
    expect(r.intent).toBe('general');
    expect(r.mode).toBe('explore');
  });

  // ── Cross-intent disambiguation ──
  describe('cross-intent edge cases', () => {
    it('"Use Safari to fill out contact form on our website" → browser (website overrides desktop)', () => {
      expect(classifyIntent('Use Safari to fill out the contact form on our website').intent).toBe('browser');
    });
    it('"Go to Chrome, open a new tab, and type in the search bar" → desktop', () => {
      expect(classifyIntent('Go to Chrome, open a new tab, and type in the search bar').intent).toBe('desktop');
    });
    it('"Use Slack to send a reaction on the latest message" → desktop (app launch)', () => {
      expect(classifyIntent('Use Slack to send a reaction on the latest message').intent).toBe('desktop');
    });
    it('"Open the Terminal and just look at what is on screen" → desktop', () => {
      expect(classifyIntent('Open the Terminal and just look at what is on screen, do not type anything').intent).toBe('desktop');
    });
  });

  // ── Multi-step section merging ──
  describe('multi-step prompts merge sections from qualifying intents', () => {
    it('desktop + browser sections for "Open Safari, go to apple.com, drag screenshot to Finder"', () => {
      const r = classifyIntent('Open Safari, go to apple.com, then drag the screenshot to Finder');
      expect(r.intent).toBe('desktop');
      expect(r.sections.has('desktop')).toBe(true);
      expect(r.sections.has('browser')).toBe(true);
    });

    it('desktop + message sections for "Open TextEdit, type a message, send via whatsapp"', () => {
      const r = classifyIntent('Open TextEdit, type a message, then send it via whatsapp to John');
      expect(r.intent).toBe('desktop');
      expect(r.sections.has('desktop')).toBe(true);
      expect(r.sections.has('channels')).toBe(true);
    });

    it('single-intent prompt does not add extra sections', () => {
      const r = classifyIntent('click on the submit button');
      expect(r.intent).toBe('desktop');
      expect(r.sections.has('desktop')).toBe(true);
      expect(r.sections.has('browser')).toBe(false);
      expect(r.sections.has('channels')).toBe(false);
    });
  });
});
