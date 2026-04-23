import { TabShell, useTabParam, type TabDef } from '../components/TabShell';
import { WebhookEventsPage } from './WebhookEvents';
import { BrowserViewerPage } from './BrowserViewer';
import { EyePage } from './Eye';
import { SettingsPage } from './Settings';

const TABS: TabDef[] = [
  { slug: 'webhooks', label: 'Webhooks' },
  { slug: 'browser', label: 'Browser' },
  { slug: 'eye', label: 'Eye' },
  { slug: 'settings', label: 'Settings' },
];

export function ControlRoomPage() {
  const [activeTab] = useTabParam('webhooks');
  return (
    <TabShell tabs={TABS} pageId="control-room">
      {(tab) => (
        <div className="flex-1 min-h-0 overflow-auto">
          {tab === 'webhooks' && <WebhookEventsPage />}
          {tab === 'browser' && <BrowserViewerPage />}
          {tab === 'eye' && <EyePage />}
          {tab === 'settings' && <SettingsPage />}
        </div>
      )}
    </TabShell>
  );
}
