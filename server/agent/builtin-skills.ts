/**
 * Skills the portal gives every cloud session that has the AgentCore browser.
 *
 * `agentcore-browser`: how to use the cloud browser and its tools to capture evidence (screenshots with numbered boxes), how to be sure
 * the evidence is from the right AWS account or environment, and what the other AgentCore services are for.
 *
 * Delivery: a Kiro session gets it as a skill file (skills/agentcore-browser/SKILL.md in kiro-cli's home, like the owner's own skills; the
 * owner's file with the same path wins). A Claude session has no skills folder in the cloud, so the same text is added to its prompt.
 */

import type { KiroConfigFile } from './kiro-config-files.ts';

export const AGENTCORE_SKILL_PATH = 'skills/agentcore-browser/SKILL.md';

export const AGENTCORE_BROWSER_SKILL = `---
name: agentcore-browser
description: Use the AgentCore cloud browser to open web apps and AWS consoles, sign in with the person, and capture screenshot evidence (numbered boxes on what to click) in the right account. Also what the other AgentCore services are for.
---

# AgentCore browser: capturing evidence

## The tools
- \`goto\` opens a page. \`snapshot\` lists what is on it (roles, names): use it to find selectors. \`get_text\` reads text. \`click\` and \`type\` act on a selector or visible text.
- \`screenshot\` returns a picture for you to look at. \`capture\` saves a PNG for a document under \`screenshots/NN-name.png\`. Give it \`highlights\` (selector or visible text, plus a label) and each gets a red box and a number 1, 2, 3 in the order given, so list them in the order of the steps. Every highlight must be on the page or nothing is saved. Put the picture in the document as a Markdown image and name the numbers in the caption.
- \`sign_in\` types a stored test account (you name only its role, you never see the password). \`wait_for_sign_in\` asks the person to sign in themselves in the portal's Browser tab (passwords, one-time codes, MFA) and waits up to 10 minutes. Never ask for or type a password yourself, and do not end your turn to wait: the browser belongs to your turn.
- The browser stays open between turns (up to an hour) and the next turn reconnects to the same tab, so a sign-in is kept. It reaches the public internet only.

## Be sure it is the right account before you capture
1. Read the instruction for the exact environment (account name, account id, region, role). If it names one, that is the one: do not substitute another account that looks similar, and do not decide that the instruction or the document is wrong. If it is unclear, ask.
2. In the AWS access portal, open the named account's role directly (the account id in the address, \`.../#/console?account_id=<id>&role_name=<role>\`) instead of picking from a list.
3. Before the first capture and after every account or region switch, read the console's top-right banner with \`get_text\` or \`snapshot\` and check the account name and id and the region match. If not, stop capturing and switch.
4. Say in the document which account (name and id), region and time each picture is from.
5. Messages the person sends while you work are read only when your turn ends. If you were told something that changes the target, it will reach you in the next turn: finish or stop at a safe point rather than carry on in the wrong place.

## Good evidence
- Read-only: look, never press anything that creates, changes, deletes, pays or sends.
- Do not show other customers' names or accounts (filter the access portal's list first) or any secret value.
- One picture per screen. If a screenshot times out, wait for the page to settle, scroll the element into view, or reload; do not keep retrying the same call.
- Use test data only for documents that show how to use a system.

## The other AgentCore services (what each is for)
- **Runtime**: serverless hosting for agents and tools, one isolated session per user or task. This portal's Kiro, Claude and Codex runners and its long-job runtime run on it.
- **Browser**: managed cloud Chrome (\`aws.browser.v1\`). Sessions are started with a timeout (default 15 minutes, maximum 8 hours); an automation stream (Playwright over WebSocket) is for the agent, and Live View lets a person watch and take over. Session recording needs a custom browser.
- **Code Interpreter**: an isolated sandbox that runs Python, JavaScript or TypeScript for an agent.
- **Gateway**: turns APIs and Lambda functions into MCP tools, and connects existing MCP servers. **Identity**: agent and user sign-in with an identity provider. **Memory**: short-term and long-term memory shared across sessions. **Observability**: traces and metrics in CloudWatch. **Policy**: rules checked on every tool call. **Registry**: a catalog of agents, tools and skills.
- This portal uses Runtime and Browser. For the others, read the AWS documentation (docs.aws.amazon.com/bedrock-agentcore) before using them, and say which parts you checked.
`;

/** The skill text without its front matter, for a prompt. */
export function agentcoreSkillBody(): string {
  return AGENTCORE_BROWSER_SKILL.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/** The Kiro config with the built-in skill added when the run has the browser. The owner's own file at the same path is kept. */
export function withBuiltinKiroSkills(config: KiroConfigFile[], browserOn: boolean): KiroConfigFile[] {
  if (!browserOn || config.some((f) => f.path === AGENTCORE_SKILL_PATH)) return config;
  return [...config, { path: AGENTCORE_SKILL_PATH, content: AGENTCORE_BROWSER_SKILL }];
}
