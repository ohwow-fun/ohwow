import { Routes, Route, Navigate } from 'react-router-dom';
import { getToken } from './api/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer } from './components/Toast';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { OnboardingPage } from './pages/Onboarding';
import { DashboardPage } from './pages/Dashboard';
import { AgentsPage } from './pages/Agents';
import { AgentDetailPage } from './pages/AgentDetail';
import { TasksPage } from './pages/Tasks';
import { TaskDetailPage } from './pages/TaskDetail';
import { ApprovalsPage } from './pages/Approvals';
import { ActivityPage } from './pages/Activity';
import { SchedulesPage } from './pages/Schedules';
import { ChatPage } from './pages/Chat';
import { MessagesPage } from './pages/Messages';
import { SettingsPage } from './pages/Settings';
import { ContactsPage } from './pages/Contacts';
import { ContactDetailPage } from './pages/ContactDetail';
import { ProjectsPage } from './pages/Projects';
import { ProjectDetailPage } from './pages/ProjectDetail';
import { AutomationsListPage } from './pages/AutomationsListPage';
import { AutomationBuilderPage } from './pages/AutomationBuilderPage';
import { ConnectionsPage } from './pages/Connections';
import { KnowledgePage } from './pages/Knowledge';
import { TemplatesPage } from './pages/TemplatesPage';
import { WorkflowsHub } from './pages/WorkflowsHub';
import { WebhookEventsPage } from './pages/WebhookEvents';
import { GoalsPage } from './pages/Goals';
import { RevenuePage } from './pages/Revenue';
import { MessagingPage } from './pages/Messaging';
import { PeersPage } from './pages/Peers';
import { TeamPage } from './pages/Team';
import { BrowserViewerPage } from './pages/BrowserViewer';
import { BriefingsPage } from './pages/Briefings';
import { PodcastPage } from './pages/Podcast';
import { EyePage } from './pages/Eye';
import { PulsePage } from './pages/Pulse';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = getToken();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<PulsePage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:id" element={<AgentDetailPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:id" element={<TaskDetailPage />} />
          <Route path="contacts" element={<ContactsPage />} />
          <Route path="contacts/:id" element={<ContactDetailPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="templates" element={<TemplatesPage />} />
          <Route path="automations" element={<AutomationsListPage />} />
          <Route path="automations/new" element={<AutomationBuilderPage />} />
          <Route path="automations/:id/edit" element={<AutomationBuilderPage />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="schedules" element={<SchedulesPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="messages" element={<MessagesPage />} />
          <Route path="workflows" element={<WorkflowsHub />} />
          <Route path="webhook-events" element={<WebhookEventsPage />} />
          <Route path="goals" element={<GoalsPage />} />
          <Route path="revenue" element={<RevenuePage />} />
          <Route path="messaging" element={<MessagingPage />} />
          <Route path="peers" element={<PeersPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="browser" element={<BrowserViewerPage />} />
          <Route path="briefings" element={<BriefingsPage />} />
          <Route path="podcast" element={<PodcastPage />} />
          <Route path="eye" element={<EyePage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      <ToastContainer />
    </ErrorBoundary>
  );
}
