/**
 * Data access for the testing module: the testing repository plus the few multi-step operations that
 * SQLite does through foreign-key cascades and DynamoDB must do explicitly.
 */
import { getTestingRepository } from '../repositories/testing-data.ts';

export const testingRepo = getTestingRepository;

/**
 * Delete a test project and everything under it. SQLite already cascades; DynamoDB stores each kind of
 * record as its own item, so they are removed one by one (children first).
 */
export async function deleteTestProjectDeep(testProjectId: string): Promise<void> {
  const repo = getTestingRepository();

  for (const cs of (await repo.listCaseSetsByTestProject(testProjectId, 100000, 0)).items) {
    for (const c of await repo.listCasesByCaseSet(cs.id)) await repo.deleteCase(c.id, cs.id);
    await repo.deleteCaseSet(cs.id);
  }
  for (const s of await repo.listScriptsByTestProject(testProjectId)) await repo.deleteTestScript(s.id);
  for (const g of await repo.listGroupsByTestProject(testProjectId)) await repo.deleteTestGroup(g.id);
  for (const v of await repo.listVaultItemsByTestProject(testProjectId)) await repo.deleteVaultItem(v.id);
  for (const f of await repo.listVaultFilesByTestProject(testProjectId)) await repo.deleteVaultFile(f.id);

  await repo.deleteTestProject(testProjectId);
}
