import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { FlowBuilder } from './automations/flow-builder/FlowBuilder';
import type { Automation } from './automations/types';

export function AutomationBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [loading, setLoading] = useState(!!id);

  useEffect(() => {
    if (!id) return;
    api<{ data: Automation }>(`/api/automations/${id}`)
      .then((res) => setAutomation(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-neutral-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <FlowBuilder automation={id ? automation : undefined} />
    </div>
  );
}
