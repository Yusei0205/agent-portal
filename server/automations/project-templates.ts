import { getAutomationsRepository, type AutomationRecord } from '../repositories/automations.ts';
import { automationTemplates, type AutomationTemplate } from './templates.ts';
import type { AutomationGraph } from './schema.ts';

export interface TemplateRecord extends AutomationRecord {
  id: string; source: 'system' | 'user'; name: string; description: string; graph: AutomationGraph;
  customized: boolean; baseVersion: number; updated_at: string; updated_by: string; deleted_at?: string;
}
export interface ProjectAutomationTemplate extends AutomationTemplate {
  source: 'system' | 'user'; revision: number; customized: boolean; baseVersion: number;
  updateAvailable: boolean; updated_at?: string;
}
export const templateKey = (id: string): string => `TEMPLATE#${id}`;

/** Defaults stay in code. Only overrides/user templates are stored in the project's existing repository partition. */
export async function projectAutomationTemplates(project: string): Promise<ProjectAutomationTemplate[]> {
  const stored = await (await getAutomationsRepository()).list<TemplateRecord>(project, 'TEMPLATE#');
  const system = automationTemplates().map((shipped): ProjectAutomationTemplate => {
    const override = stored.find((record) => record.id === shipped.id && record.source === 'system');
    const customized = override?.customized === true;
    return { ...shipped, ...(customized ? { name: override.name, description: override.description, graph: override.graph } : {}),
      source: 'system', revision: override?.revision || 0, customized, baseVersion: customized ? override.baseVersion : shipped.version || 1,
      updateAvailable: customized && override.baseVersion < (shipped.version || 1), updated_at: override?.updated_at };
  });
  const users = stored.filter((record) => record.source === 'user' && !record.deleted_at).map((record): ProjectAutomationTemplate => ({
    id: record.id, name: record.name, description: record.description, graph: record.graph, category: 'Custom', source: 'user',
    revision: record.revision, customized: false, baseVersion: 0, updateAvailable: false, updated_at: record.updated_at,
  }));
  return [...system, ...users.sort((a, b) => a.name.localeCompare(b.name))];
}
