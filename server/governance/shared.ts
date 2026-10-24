/** Helpers shared by the governance modules. */
import { badRequest, str } from '../util.ts';

export function checkEmail(e: unknown): string {
  const email = str(e, 'Email', { max: 200 }).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address');
  return email;
}
