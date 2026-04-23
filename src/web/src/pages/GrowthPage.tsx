import { TabShell, useTabParam, type TabDef } from '../components/TabShell';
import { GoalsPage } from './Goals';
import { RevenuePage } from './Revenue';
import { MarketingPage } from './Marketing';
import { SocialPage } from './Social';

const TABS: TabDef[] = [
  { slug: 'goals', label: 'Goals' },
  { slug: 'revenue', label: 'Revenue' },
  { slug: 'marketing', label: 'Marketing' },
  { slug: 'social', label: 'Social' },
];

export function GrowthPage() {
  const [activeTab] = useTabParam('goals');
  return (
    <TabShell tabs={TABS} pageId="growth">
      {(tab) => (
        <div className="flex-1 min-h-0 overflow-auto">
          {tab === 'goals' && <GoalsPage />}
          {tab === 'revenue' && <RevenuePage />}
          {tab === 'marketing' && <MarketingPage />}
          {tab === 'social' && <SocialPage />}
        </div>
      )}
    </TabShell>
  );
}
