import { TabShell, useTabParam, type TabDef } from '../components/TabShell';
import { DashboardPage } from './Dashboard';
import { ActivityPage } from './Activity';
import { ApprovalsPage } from './Approvals';

const TABS: TabDef[] = [
  { slug: 'overview', label: 'Overview' },
  { slug: 'activity', label: 'Activity' },
  { slug: 'approvals', label: 'Approvals' },
];

export function IntelligencePage() {
  const [activeTab] = useTabParam('overview');
  return (
    <TabShell tabs={TABS} pageId="intelligence">
      {(tab) => (
        <div className="flex-1 min-h-0 overflow-auto">
          {tab === 'overview' && <DashboardPage />}
          {tab === 'activity' && <ActivityPage />}
          {tab === 'approvals' && <ApprovalsPage />}
        </div>
      )}
    </TabShell>
  );
}
