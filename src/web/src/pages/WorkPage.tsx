import { TabShell, useTabParam, type TabDef } from '../components/TabShell';
import { TasksPage } from './Tasks';
import { ProjectsPage } from './Projects';
import { AutomationsListPage } from './AutomationsListPage';
import { SchedulesPage } from './Schedules';
import { TemplatesPage } from './TemplatesPage';

const TABS: TabDef[] = [
  { slug: 'tasks', label: 'Tasks' },
  { slug: 'projects', label: 'Projects' },
  { slug: 'automations', label: 'Automations' },
  { slug: 'schedules', label: 'Schedules' },
  { slug: 'templates', label: 'Templates' },
];

export function WorkPage() {
  const [activeTab] = useTabParam('tasks');
  return (
    <TabShell tabs={TABS} pageId="work">
      {(tab) => (
        <div className="flex-1 min-h-0 overflow-auto">
          {tab === 'tasks' && <TasksPage />}
          {tab === 'projects' && <ProjectsPage />}
          {tab === 'automations' && <AutomationsListPage />}
          {tab === 'schedules' && <SchedulesPage />}
          {tab === 'templates' && <TemplatesPage />}
        </div>
      )}
    </TabShell>
  );
}
