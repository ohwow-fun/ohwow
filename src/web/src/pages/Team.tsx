import { useState } from 'react';
import { UsersThree, Plus, Pencil, Trash, Buildings, UserCircle } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { TabSwitcher } from '../components/TabSwitcher';
import { RowSkeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FeatureIntro } from '../components/FeatureIntro';
import { api } from '../api/client';
import { toast } from '../components/Toast';

interface Department {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

interface TeamMember {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  department_id: string | null;
  skills: string | null;
  capacity: number | null;
  created_at: string;
}

const TABS = [
  { id: 'departments', label: 'Departments' },
  { id: 'members', label: 'Members' },
];

export function TeamPage() {
  const [tab, setTab] = useState('departments');

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader title="Team" subtitle="Departments and team members" />
      <div className="mb-6">
        <TabSwitcher tabs={TABS} activeTab={tab} onTabChange={setTab} layoutId="team-tab" />
      </div>
      {tab === 'departments' && <DepartmentsTab />}
      {tab === 'members' && <MembersTab />}
    </div>
  );
}

function DepartmentsTab() {
  const { data: departments, loading, refetch } = useApi<Department[]>('/api/departments');
  const [showForm, setShowForm] = useState(false);
  const [editDept, setEditDept] = useState<Department | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Department | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/departments/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', 'Department deleted');
      refetch();
    } catch {
      toast('error', 'Couldn\'t delete department');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (loading) return <RowSkeleton count={3} />;

  if (!departments?.length) {
    return (
      <FeatureIntro
        icon={Buildings}
        title="No departments yet"
        description="Create departments to organize your agents and team members."
        capabilities={[
          { icon: Buildings, label: 'Organization', description: 'Group agents by function' },
          { icon: UsersThree, label: 'Team structure', description: 'Define team hierarchy' },
        ]}
        action={{ label: 'Create department', onClick: () => { setEditDept(null); setShowForm(true); } }}
      />
    );
  }

  return (
    <>
      <div className="flex justify-end mb-4">
        <button onClick={() => { setEditDept(null); setShowForm(true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors">
          <Plus size={14} /> Add department
        </button>
      </div>
      <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
        {departments.map(dept => (
          <div key={dept.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">{dept.name}</p>
              {dept.description && <p className="text-xs text-neutral-400">{dept.description}</p>}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => { setEditDept(dept); setShowForm(true); }} className="text-neutral-400 hover:text-white transition-colors"><Pencil size={13} /></button>
              <button onClick={() => setDeleteTarget(dept)} className="text-neutral-400 hover:text-critical transition-colors"><Trash size={13} /></button>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <DeptForm dept={editDept} onClose={() => { setShowForm(false); setEditDept(null); }} onSuccess={() => { refetch(); setShowForm(false); setEditDept(null); }} />
      )}

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={handleDelete}
        title="Delete department" message={`Delete "${deleteTarget?.name}"?`} confirmLabel="Delete" loading={deleting} />
    </>
  );
}

function DeptForm({ dept, onClose, onSuccess }: { dept: Department | null; onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState(dept?.name || '');
  const [description, setDescription] = useState(dept?.description || '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null };
      if (dept) {
        await api(`/api/departments/${dept.id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('success', 'Department updated');
      } else {
        await api('/api/departments', { method: 'POST', body: JSON.stringify(body) });
        toast('success', 'Department created');
      }
      onSuccess();
    } catch {
      toast('error', dept ? 'Couldn\'t update department' : 'Couldn\'t create department');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={dept ? 'Edit department' : 'New department'} maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Engineering"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20" autoFocus />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Description</label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this department does"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20" />
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">Cancel</button>
          <button type="submit" disabled={submitting || !name.trim()}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors">
            {submitting ? 'Saving...' : (dept ? 'Update' : 'Create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MembersTab() {
  const { data: members, loading, refetch } = useApi<TeamMember[]>('/api/team-members');
  const { data: departments } = useApi<Department[]>('/api/departments');
  const [showForm, setShowForm] = useState(false);
  const [editMember, setEditMember] = useState<TeamMember | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeamMember | null>(null);
  const [deleting, setDeleting] = useState(false);

  const getDeptName = (id: string | null) => {
    if (!id || !departments) return null;
    return departments.find(d => d.id === id)?.name || null;
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/team-members/${deleteTarget.id}`, { method: 'DELETE' });
      toast('success', 'Member removed');
      refetch();
    } catch {
      toast('error', 'Couldn\'t remove member');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (loading) return <RowSkeleton count={3} />;

  if (!members?.length) {
    return (
      <FeatureIntro
        icon={UserCircle}
        title="No team members yet"
        description="Add team members to track human collaborators alongside your AI agents."
        capabilities={[
          { icon: UserCircle, label: 'Profiles', description: 'Name, email, role' },
          { icon: Buildings, label: 'Departments', description: 'Assign to departments' },
        ]}
        action={{ label: 'Add team member', onClick: () => { setEditMember(null); setShowForm(true); } }}
      />
    );
  }

  return (
    <>
      <div className="flex justify-end mb-4">
        <button onClick={() => { setEditMember(null); setShowForm(true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors">
          <Plus size={14} /> Add member
        </button>
      </div>
      <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
        {members.map(member => (
          <div key={member.id} className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs font-bold">
                {member.name[0]?.toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium">{member.name}</p>
                <p className="text-xs text-neutral-400">
                  {member.role || 'No role'}
                  {getDeptName(member.department_id) && <span className="ml-2">· {getDeptName(member.department_id)}</span>}
                  {member.email && <span className="ml-2">· {member.email}</span>}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => { setEditMember(member); setShowForm(true); }} className="text-neutral-400 hover:text-white transition-colors"><Pencil size={13} /></button>
              <button onClick={() => setDeleteTarget(member)} className="text-neutral-400 hover:text-critical transition-colors"><Trash size={13} /></button>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <MemberForm member={editMember} departments={departments || []} onClose={() => { setShowForm(false); setEditMember(null); }}
          onSuccess={() => { refetch(); setShowForm(false); setEditMember(null); }} />
      )}

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={handleDelete}
        title="Remove member" message={`Remove "${deleteTarget?.name}"?`} confirmLabel="Remove" loading={deleting} />
    </>
  );
}

function MemberForm({ member, departments, onClose, onSuccess }: {
  member: TeamMember | null; departments: Department[]; onClose: () => void; onSuccess: () => void;
}) {
  const [name, setName] = useState(member?.name || '');
  const [email, setEmail] = useState(member?.email || '');
  const [role, setRole] = useState(member?.role || '');
  const [deptId, setDeptId] = useState(member?.department_id || '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const body = { name: name.trim(), email: email.trim() || null, role: role.trim() || null, department_id: deptId || null };
      if (member) {
        await api(`/api/team-members/${member.id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('success', 'Member updated');
      } else {
        await api('/api/team-members', { method: 'POST', body: JSON.stringify(body) });
        toast('success', 'Member added');
      }
      onSuccess();
    } catch {
      toast('error', member ? 'Couldn\'t update member' : 'Couldn\'t add member');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={member ? 'Edit member' : 'New member'} maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20" autoFocus />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Role</label>
            <input value={role} onChange={e => setRole(e.target.value)} placeholder="Product Manager"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20" />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Department</label>
            <select value={deptId} onChange={e => setDeptId(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20">
              <option value="">None</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">Cancel</button>
          <button type="submit" disabled={submitting || !name.trim()}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors">
            {submitting ? 'Saving...' : (member ? 'Update' : 'Add member')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
