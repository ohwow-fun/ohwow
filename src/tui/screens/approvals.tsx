/**
 * Approvals Screen
 * Tasks requiring approval with inline output view, rejection reasons, and bulk actions.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ControlPlaneClient } from '../../control-plane/client.js';
import type { TaskRow } from '../types.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { TextPanel } from '../components/text-panel.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { InputField } from '../components/input-field.js';
import { getEventBus } from '../hooks/use-event-bus.js';

interface ApprovalsListProps {
  db: DatabaseAdapter | null;
  controlPlane?: ControlPlaneClient | null;
  onSelect?: (id: string) => void;
}

interface DeferredActionData {
  type: string;
  params: Record<string, unknown>;
  provider: string;
}

interface ApprovalTask {
  id: string;
  workspace_id: string;
  agent_id: string;
  title: string;
  output: string;
  created_at: string;
  deferred_action: DeferredActionData | null;
}

type ApprovalState =
  | { phase: 'idle' }
  | { phase: 'reason-input'; reason: string }
  | { phase: 'confirm'; action: 'approve' | 'reject'; reason?: string; retry?: boolean }
  | { phase: 'bulk-confirm'; action: 'approve' | 'reject' };

export function ApprovalsList({ db, controlPlane }: ApprovalsListProps) {
  const [tasks, setTasks] = useState<ApprovalTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<ApprovalTask | null>(null);
  const [approvalState, setApprovalState] = useState<ApprovalState>({ phase: 'idle' });
  const [agentNames, setAgentNames] = useState<Map<string, string>>(new Map());

  // Fetch agent names
  useEffect(() => {
    if (!db) return;
    const fetchNames = async () => {
      const { data } = await db
        .from('agent_workforce_agents')
        .select('id, name');
      if (data) {
        const map = new Map(
          (data as Array<{ id: string; name: string }>).map(a => [a.id, a.name])
        );
        setAgentNames(map);
      }
    };
    fetchNames();
  }, [db]);

  useEffect(() => {
    if (!db) return;

    const fetch = async () => {
      const { data } = await db
        .from<TaskRow & { deferred_action?: string | DeferredActionData | null }>('agent_workforce_tasks')
        .select('*')
        .eq('status', 'needs_approval')
        .order('created_at', { ascending: false });

      if (data) {
        const items = data.map(t => {
          let deferredAction: DeferredActionData | null = null;
          if (t.deferred_action) {
            deferredAction = typeof t.deferred_action === 'string'
              ? JSON.parse(t.deferred_action) as DeferredActionData
              : t.deferred_action;
          }
          return {
            id: t.id,
            workspace_id: t.workspace_id,
            agent_id: t.agent_id,
            title: t.title,
            output: typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2),
            created_at: t.created_at,
            deferred_action: deferredAction,
          };
        });
        setTasks(items);
      }
    };

    fetch();
    const timer = setInterval(fetch, 5000);
    return () => clearInterval(timer);
  }, [db]);

  const handleApproval = useCallback(async (taskId: string, workspaceId: string, agentId: string, title: string, action: 'approve' | 'reject', reason?: string, deferredAction?: DeferredActionData | null) => {
    if (!db) return;

    const now = new Date().toISOString();
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await db.from('agent_workforce_tasks').update({
      status: newStatus,
      updated_at: now,
      ...(action === 'approve' ? { approved_at: now, approved_by: 'runtime' } : {}),
      ...(action === 'reject' && reason ? { rejection_reason: reason } : {}),
    }).eq('id', taskId);

    // Execute deferred action via control plane on approve
    let actionResult = '';
    if (action === 'approve' && deferredAction) {
      if (controlPlane) {
        const result = await controlPlane.executeDeferredAction(taskId, deferredAction);
        actionResult = result.success
          ? ` Action (${deferredAction.type}) executed.`
          : ` Action failed: ${result.error}`;
      } else {
        actionResult = ` Action (${deferredAction.type}) requires cloud connection.`;
      }
    }

    // Update deliverable record if one exists
    const { data: deliverable } = await db
      .from('agent_workforce_deliverables')
      .select('id')
      .eq('task_id', taskId)
      .single();

    if (deliverable) {
      const deliv = deliverable as { id: string };
      const delivUpdate: Record<string, unknown> = {
        reviewed_by: 'runtime',
        reviewed_at: now,
        updated_at: now,
      };
      if (action === 'approve') {
        delivUpdate.status = deferredAction && actionResult.includes('executed')
          ? 'delivered' : 'approved';
        if (delivUpdate.status === 'delivered') delivUpdate.delivered_at = now;
      } else {
        delivUpdate.status = 'rejected';
        if (reason) delivUpdate.rejection_reason = reason;
      }
      await db.from('agent_workforce_deliverables').update(delivUpdate).eq('id', deliv.id);
    }

    // Log activity
    await db.rpc('create_agent_activity', {
      p_workspace_id: workspaceId,
      p_activity_type: action === 'approve' ? 'task_approved' : 'task_rejected',
      p_title: `${title} \u2014 ${newStatus}`,
      p_description: (action === 'reject' && reason ? `Rejected: ${reason}` : `Task ${action}d locally`) + actionResult,
      p_agent_id: agentId,
      p_task_id: taskId,
      p_metadata: { runtime: true },
    });

    getEventBus().emit('task:completed', {
      taskId,
      agentId,
      status: newStatus,
      tokensUsed: 0,
      costCents: 0,
    });
  }, [db, controlPlane]);

  const handleSingleAction = useCallback(async () => {
    if (!selectedTask || approvalState.phase !== 'confirm') return;
    const { action, reason } = approvalState;

    await handleApproval(selectedTask.id, selectedTask.workspace_id, selectedTask.agent_id, selectedTask.title, action, reason, selectedTask.deferred_action);

    setSelectedTask(null);
    setApprovalState({ phase: 'idle' });
    setTasks(t => t.filter(task => task.id !== selectedTask.id));
  }, [selectedTask, approvalState, handleApproval]);

  const handleBulkAction = useCallback(async () => {
    if (approvalState.phase !== 'bulk-confirm') return;
    const { action } = approvalState;

    for (const task of tasks) {
      await handleApproval(task.id, task.workspace_id, task.agent_id, task.title, action, undefined, task.deferred_action);
    }

    setTasks([]);
    setApprovalState({ phase: 'idle' });
  }, [tasks, approvalState, handleApproval]);

  useInput((input, key) => {
    // Handle reason input mode — let TextInput handle all keys
    if (approvalState.phase === 'reason-input') {
      if (key.escape) {
        setApprovalState({ phase: 'idle' });
      }
      return;
    }

    // Handle confirm dialogs
    if (approvalState.phase === 'confirm' || approvalState.phase === 'bulk-confirm') {
      return;
    }

    // Detail view actions
    if (selectedTask) {
      if (input === 'a') {
        setApprovalState({ phase: 'confirm', action: 'approve' });
        return;
      }
      if (input === 'r') {
        setApprovalState({ phase: 'reason-input', reason: '' });
        return;
      }
      return;
    }

    // Note: After reason input, pressing Enter proceeds to confirm.
    // The confirm dialog handles the actual action.

    // List view bulk actions (uppercase)
    if (input === 'A' && tasks.length > 0) {
      setApprovalState({ phase: 'bulk-confirm', action: 'approve' });
      return;
    }
    if (input === 'R' && tasks.length > 0) {
      setApprovalState({ phase: 'bulk-confirm', action: 'reject' });
      return;
    }
  });

  // Rejection reason input view
  if (selectedTask && approvalState.phase === 'reason-input') {
    return (
      <Box flexDirection="column">
        <Text bold>{selectedTask.title}</Text>
        <Box marginTop={1}>
          <InputField
            label="Rejection reason"
            value={approvalState.reason}
            onChange={(val) => setApprovalState({ phase: 'reason-input', reason: val })}
            onSubmit={() => {
              setApprovalState({ phase: 'confirm', action: 'reject', reason: approvalState.reason || undefined });
            }}
            placeholder="Enter reason and press Enter..."
          />
        </Box>
        <Box marginTop={1}>
          <Text color="gray"><Text bold>Enter</Text>: reject, <Text bold>Esc</Text>: cancel</Text>
        </Box>
      </Box>
    );
  }

  // Detail view with task output
  if (selectedTask) {
    return (
      <Box flexDirection="column">
        <Text bold>{selectedTask.title}</Text>
        {agentNames.get(selectedTask.agent_id) && (
          <Text color="gray">Agent: {agentNames.get(selectedTask.agent_id)}</Text>
        )}
        {selectedTask.deferred_action && (
          <Text color="yellow">
            {selectedTask.deferred_action.provider === 'gmail' ? '\u{1F4E7}' : '\u26A1'} Deferred: {selectedTask.deferred_action.type}
            {selectedTask.deferred_action.params.to ? ` \u2192 ${selectedTask.deferred_action.params.to}` : ''}
          </Text>
        )}
        <TextPanel content={selectedTask.output} title="Task Output" />
        <Box marginTop={1}>
          <Text color="gray">Press <Text bold color="green">a</Text>:approve  <Text bold color="red">r</Text>:reject  <Text bold>Esc</Text>:back</Text>
        </Box>
        {approvalState.phase === 'confirm' && (
          <ConfirmDialog
            message={`${approvalState.action === 'approve' ? 'Approve' : 'Reject'} this task?${approvalState.reason ? ` Reason: "${approvalState.reason}"` : ''}`}
            onConfirm={() => handleSingleAction()}
            onCancel={() => setApprovalState({ phase: 'idle' })}
          />
        )}
      </Box>
    );
  }

  // List view
  return (
    <Box flexDirection="column">
      <Text bold>Pending Approvals ({tasks.length})</Text>
      <Box marginTop={1}>
        <ScrollableList
          items={tasks}
          onSelect={(task) => setSelectedTask(task)}
          emptyMessage="No tasks pending approval."
          renderItem={(task, _, isSelected) => (
            <Text bold={isSelected}>
              <Text color="magenta">{'\u231B'}</Text> {task.deferred_action ? <Text color="yellow">{task.deferred_action.provider === 'gmail' ? '\u{1F4E7}' : '\u26A1'}</Text> : null}{task.deferred_action ? ' ' : ''}{agentNames.get(task.agent_id) ? <Text color="cyan">{agentNames.get(task.agent_id)}</Text> : null}{agentNames.get(task.agent_id) ? ' \u2014 ' : ''}{task.title}
            </Text>
          )}
        />
      </Box>
      {tasks.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray">
            <Text bold color="white">Enter</Text>:view  <Text bold color="white">A</Text>:approve all  <Text bold color="white">R</Text>:reject all
          </Text>
        </Box>
      )}
      {approvalState.phase === 'bulk-confirm' && (
        <ConfirmDialog
          message={`${approvalState.action === 'approve' ? 'Approve' : 'Reject'} all ${tasks.length} pending tasks?`}
          onConfirm={() => handleBulkAction()}
          onCancel={() => setApprovalState({ phase: 'idle' })}
        />
      )}
    </Box>
  );
}
