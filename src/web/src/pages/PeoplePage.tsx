import { TabShell, useTabParam, type TabDef } from '../components/TabShell';
import { TeamPage } from './Team';
import { PeersPage } from './Peers';
import { ConnectionsPage } from './Connections';
import { MessagingPage } from './Messaging';

const TABS: TabDef[] = [
  { slug: 'agents', label: 'Agents' },
  { slug: 'peers', label: 'Peers' },
  { slug: 'connections', label: 'Connections' },
  { slug: 'messaging', label: 'Messaging' },
];

export function PeoplePage() {
  const [activeTab] = useTabParam('agents');
  return (
    <TabShell tabs={TABS} pageId="people">
      {(tab) => (
        <div className="flex-1 min-h-0 overflow-auto">
          {tab === 'agents' && <TeamPage />}
          {tab === 'peers' && <PeersPage />}
          {tab === 'connections' && <ConnectionsPage />}
          {tab === 'messaging' && <MessagingPage />}
        </div>
      )}
    </TabShell>
  );
}
