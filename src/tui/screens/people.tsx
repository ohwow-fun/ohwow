/**
 * People Screen
 * Terminal list view of team members grouped by group_label.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

interface TeamMemberRow {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  group_label: string | null;
  status: string;
  notification_preferences: string | null;
}

interface PeopleListProps {
  db: DatabaseAdapter;
  workspaceId: string;
}

export function PeopleList({ db, workspaceId }: PeopleListProps) {
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await db.from<TeamMemberRow>('agent_workforce_team_members')
        .select('id, name, role, email, phone, group_label, status, notification_preferences')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      setMembers(data ?? []);
      setLoading(false);
    })();
  }, [db, workspaceId]);

  if (loading) {
    return <Text dimColor>Loading people...</Text>;
  }

  if (members.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No team members yet. Add people via the dashboard or /api/team-members.</Text>
      </Box>
    );
  }

  // Group by group_label
  const groups = new Map<string, TeamMemberRow[]>();
  for (const m of members) {
    const label = m.group_label || 'Everyone';
    const list = groups.get(label) || [];
    list.push(m);
    groups.set(label, list);
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>People</Text>
      <Text dimColor>{members.length} {members.length === 1 ? 'member' : 'members'}</Text>
      <Box marginTop={1} flexDirection="column">
        {[...groups.entries()].map(([label, groupMembers]) => (
          <Box key={label} flexDirection="column" marginBottom={1}>
            {groups.size > 1 && (
              <Text dimColor bold>{label}</Text>
            )}
            {groupMembers.map((m) => {
              const channels = parseChannels(m.notification_preferences);
              return (
                <Box key={m.id} paddingLeft={groups.size > 1 ? 2 : 0}>
                  <Text color={m.status === 'active' ? 'white' : 'gray'}>
                    {m.name}
                  </Text>
                  {m.role && <Text dimColor>  {m.role}</Text>}
                  {channels.length > 0 && (
                    <Text dimColor>  [{channels.join(', ')}]</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function parseChannels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return parsed?.channels || [];
  } catch {
    return [];
  }
}
