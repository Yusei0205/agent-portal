/**
 * Repository interface for user feedback.
 *
 * Feedback is a small, low-volume list (a person sends it, an admin sorts it), so the DynamoDB version keeps it in
 * the portal-feedback table (PK=FEEDBACK, SK=FB#<id>) and filters in memory; no index is needed.
 */

import { SqliteFeedbackRepository } from './feedback-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

export const FEEDBACK_KINDS = ['bug', 'idea', 'question', 'other'] as const;
export const FEEDBACK_STATUSES = ['new', 'accepted', 'in_progress', 'in_review', 'approved', 'fixed', 'declined'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface FeedbackRecord {
  id: string;
  user_id: string;
  user_name: string | null;
  kind: FeedbackKind;
  title: string;
  body: string;
  /** The portal page the person was on (a hash such as `#/p/x/sessions`). */
  page: string | null;
  status: FeedbackStatus;
  admin_note: string | null;
  /** The session an admin started for it, and the project and repository it works on. */
  project_id: string | null;
  workflow_id: string | null;
  repo_id: string | null;
  /** The pull request that came out of the session. */
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  decision_note: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export type FeedbackPatch = Partial<Omit<FeedbackRecord, 'id' | 'user_id' | 'created_at'>>;

export interface FeedbackRepository {
  create(rec: FeedbackRecord): Promise<void>;
  getById(id: string): Promise<FeedbackRecord | null>;
  /** Newest first, at most 500. */
  listAll(): Promise<FeedbackRecord[]>;
  listByUser(userId: string): Promise<FeedbackRecord[]>;
  update(id: string, patch: FeedbackPatch): Promise<FeedbackRecord | null>;
}

let _instance: FeedbackRepository | null = null;

export async function initFeedbackRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbFeedbackRepository } = await import('./feedback-dynamodb.ts');
    _instance = new DynamoDbFeedbackRepository();
  } else {
    _instance = new SqliteFeedbackRepository();
  }
}

export function getFeedbackRepository(): FeedbackRepository {
  if (!_instance) _instance = new SqliteFeedbackRepository();
  return _instance;
}

export function setFeedbackRepository(repo: FeedbackRepository): void { _instance = repo; }
export function clearFeedbackRepository(): void { _instance = null; }
