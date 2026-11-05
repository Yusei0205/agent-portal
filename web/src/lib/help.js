// User guide content for the Help page. One section per module of the portal.
// `id` matches the route tab of the page it describes, so the Help link in the
// menu can open the section for the page you are on.

export const HELP_SECTIONS = [
  {
    id: 'start',
    title: 'Getting started',
    icon: 'question',
    body: `
The Agent Portal runs Claude agents on your projects. Each project keeps its own documents,
repositories, agents, skills, runs and members.

## Finding your way around

- **Left menu.** Use the **Project** list at the top to pick a project. Once a project is picked,
  the menu shows its pages: Knowledge, Learn, Agent runs, Code review, Repositories, Agents and
  skills, and Project and team. Choose **All projects** to go back to the project list.
- **Bottom of the menu.** **Feedback**, **Help**, **Settings** (admins only), the current model
  provider, this month's spend, your name (opens [Your account](#/help/account)) and **Sign out**.
- **On a phone.** The menu is hidden; open it with the menu button at the top left.

## First steps

1. The first person to open the portal creates the **admin account**. Everyone else gets an
   account from an admin under [Settings › Users](#/help/settings).
2. Create a project on the [Projects](#/help/projects) page.
3. Upload the project's FSD, TSD and other documents under [Knowledge](#/help/knowledge).
4. Connect its code under [Repositories](#/help/repos).
5. Add role agents under [Agents and skills](#/help/builder).
6. Start a task under [Agent runs](#/help/runs).

## Demo mode

A new portal starts in **Demo mode**: a simulated agent, so every page works without an API key
and nothing is charged. The badge at the bottom of the menu shows it. An admin switches to the
Anthropic API or Amazon Bedrock under [Settings › Model provider](#/help/settings).

## Who can do what

| Access | Can do |
| --- | --- |
| **Viewer** | Read documents, ask questions, follow runs and reviews, take published quizzes. |
| **Editor** | Everything a viewer can, plus upload documents, start runs and reviews, connect repositories, and edit agents, skills and learning content. |
| **Owner** | Everything an editor can, plus change project details, members, archive and delete. |
| **Admin** | A portal-wide role: changes Settings and user accounts and handles the Feedback inbox. |

Project access is set per project under [Project and team](#/help/team).
`,
  },
  {
    id: 'projects',
    title: 'Projects',
    icon: 'projects',
    body: `
The **Projects** page lists every project you belong to, with its number of documents,
repositories and members, your access, and any open questions waiting for an answer.

## Create a project

1. Press **New project** (or **Create your first project**).
2. Give it a **Name** and say **What is it about?** in a sentence or two. Agents read this first.
3. Press **Create project**. You land on its Knowledge page.

Only you can see a new project until you add members under [Project and team](#/help/team).

## Archived projects

Archived projects are hidden from the list and the project switcher. Press
**Show archived projects** to see them again. Owners archive and restore projects under
[Project and team](#/help/team).
`,
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    icon: 'knowledge',
    body: `
**Knowledge** holds the project documents that agents search before they answer, and the
questions they raise. It has four tabs.

## Documents

- Press **Choose files** or drop files on the page to upload. Supported: Word (.docx),
  PDF, Excel (.xlsx), PowerPoint (.pptx), Markdown, text, HTML, CSV, JSON and YAML. .odt, .rtf
  and .epub work when the server has pandoc.
- Each file is converted to Markdown and indexed. Open a document to read it with an outline of
  its sections on the left.
- Use the search box (**Search all documents and decisions**) to find text across every document
  and the decisions log. Matches are highlighted.
- From a document you can **Download original**, **Convert again** (after a converter update), or
  delete it. Uploading a file with the same name replaces it; learning documents written from it
  are then marked *Sources changed* (see [Learn](#/help/learn)).

## Ask

Type a question in **Ask anything about this project** and press **Ask**. The answer cites the
document sections it used; click a citation to see the source. If the documents don't answer it,
press **Ask the team** to send it to Open questions.

## Open questions

Questions waiting for a person: ones sent from Ask, and ones agents raise during a run when they
are unsure instead of guessing. Type **Your answer** and press **Send answer**, or dismiss the
question. The number next to Knowledge in the menu shows how many are open.

## Decisions log

Every answer is recorded here and saved in the project's \`docs/decisions.md\`. All agents read
it first, so nobody is asked the same thing twice.
`,
  },
  {
    id: 'learn',
    title: 'Learn',
    icon: 'learn',
    body: `
**Learn** turns the project documents into documentation and quizzes, in plain language for
everyone and in detail for engineers. Editors write and publish; everyone reads what is published.

## Documents

1. Press **Write a document** and pick a type: **System overview**, **Feature guide**,
   **Glossary** or **FAQ**.
2. Choose the **Audience** (**For everyone** or **For engineers**), and optionally narrow the
   sources with **Only about**, for example "refund approval".
3. Read the draft. Use **Edit this version** to change it, or **Write again** for a new draft.
   **Written from** lists the source sections.
4. Press **Approve and publish** so others can see it. **Unpublish** hides it again.

Switch between **For everyone** and **For engineers** at the top of a document to read the other
version. **Print or PDF** prints it. When a source document changes, the learning document shows
*Sources changed*; write it again to bring it up to date.

## Quizzes

- Press **Make a quiz** (or **Make a quiz from this** on a document). Choose the source and the
  **Difficulty** (Easy, Medium, Hard).
- Questions are checked against their sources. Edit, reorder or remove questions, then publish.
- Readers take the quiz and see their score and each explanation. **Attempts** lists past tries.

## Onboarding paths

A path is an ordered list of documents to read and quizzes to pass (70% to pass). Build one
step by step, or press **Path for everyone** / **Path for engineers** to have one drafted for you.
Readers press **Mark as read** on documents and see **Your progress**.

## Team progress

Editors see how far each member has got through each published path.
`,
  },
  {
    id: 'runs',
    title: 'Agent runs',
    icon: 'runs',
    body: `
**Agent runs** is where you give the agents a task and watch them work.

## Start a run

1. Under **What should the agents do?**, describe the task: the feature, the outcome you want,
   and anything the agents must not change.
2. Pick a **Repository** and **Branch** (or *No repository* for documents-only work). The run
   gets its own working copy of that branch.
3. Choose the **Model**: **Sonnet** (balanced, the default), **Haiku** (cheapest) or **Opus**
   (hardest tasks).
4. Choose how changes are handled:
   - **Ask before changes**: edits and commands wait for your approval.
   - **Auto-accept edits**: file edits in the run's working copy go ahead; commands still ask.
   - **Plan only**: reads and plans; changes nothing.
5. Press **Start run**.

## Follow a run

- The **Agents in this run** tree shows the main agent and the subagents it delegated to.
  Click one to see its tool calls, messages and cost.
- **Waiting for you** lists questions and approvals. Answer questions with **Send answer**
  (answers go to the decisions log). For an edit or command, press **Allow once**,
  **Allow … for this run**, or **Deny**.
- The tabs show the **Request**, the **Result**, and **Files and changes** (a diff of every
  changed file).
- **Stop** ends a run that is going the wrong way.
- Each run shows its **Cost** (in Demo mode, what it **Would cost**).

## Continue and finish

- Type in the box at the bottom and press **Send follow-up** to ask for changes or the next
  step. The agent keeps the context of the run.
- Press **Push changes** to commit the work to a new branch. Add a **Commit message**, and for
  GitHub tick **Open a draft pull request on GitHub** if you want one.

The run list can be filtered to **Runs**, **Tests** (from [Agents and skills](#/help/builder))
and **Reviews** (from [Code review](#/help/review)).
`,
  },
  {
    id: 'review',
    title: 'Code review',
    icon: 'review',
    body: `
**Code review** has agents review a branch or pull request against the project documents and
security and testing checklists.

## Start a review

1. Press **New review** (or **Review a branch**).
2. Pick the **Repository**, then what to review:
   - **Two branches**: the branch with the **Changes on** it, **Compared with** a base such as
     \`main\`.
   - **Pull request**: an open GitHub pull request.
3. Turn on **Deep look at risky files** for a second, more thorough pass on the files the first
   pass flagged. It costs more.
4. Press **Start review**.

A quick first pass runs on Haiku; the deep look uses Sonnet.

## Work through the findings

- Findings sit next to the changed lines, with a severity: **critical**, **high**, **medium**,
  **low** or **info**. Click severities in the bar to filter.
- **Accept** a finding you agree with, **Dismiss** one you don't, or **Reopen** it later.
  **Show dismissed** brings dismissed ones back into view.
- For a GitHub pull request, **Post to GitHub** posts the findings as review comments.
`,
  },
  {
    id: 'repos',
    title: 'Repositories',
    icon: 'repos',
    body: `
**Repositories** connects the project's code. Agents read these, and each run that changes code
gets its own working copy on a branch. Agents never change the reference copy.

## Connect a repository

1. Press **Connect a repository**.
2. Under **Where is it hosted?** choose:
   - **GitHub**: paste the repository address. Add an **Access token** for private repositories,
     and one that can push if agents should push branches or open pull requests.
   - **AWS CodeCommit**: pick the **AWS region**, then the repository from the list
     (**Refresh** reloads it). It uses the AWS sign-in from [Settings](#/help/settings).
   - **Other Git**: paste the **Repository address**. Some servers, like Bitbucket, also need a
     **Username for the token**.
3. Optionally set a **Display name** and **Default branch**, then press **Connect and clone**.

The repository is ready when it shows **Ready**. Tokens are stored encrypted and never shown
again.

## Manage repositories

- **Sync** fetches the latest commits.
- **Edit** changes the name, default branch or token; **Remove saved token** clears the token.
- **Disconnect** removes the portal's copy. The remote repository is not touched.
`,
  },
  {
    id: 'builder',
    title: 'Agents and skills',
    icon: 'builder',
    body: `
**Agents and skills** defines the role agents the main agent can delegate to, and the skills that
teach them how the project works. They are stored in the project's \`.claude\` folder and every
change is committed, so older versions can be restored.

## Roles

Ready-made role templates: Business analyst, Solution architect, Backend developer, Frontend
developer, QA engineer, Reviewer, and Technical writer and trainer. Press **Add to project** to
add a role with its skills. Added roles show **In use**.

## Agents

- Press **New agent** to create your own, or pick one from the list to edit it.
- **Name**: lowercase letters, digits and hyphens, like \`payments-expert\`.
- **When should the main agent use it?**: this description decides delegation, so be specific
  about the tasks it handles.
- **Model**: same as the main agent, or Haiku, Sonnet or Opus.
- **Instructions**: the agent's system prompt, in Markdown. Use **Edit** and **Preview**.
- **Available to agents** turns an agent on or off without deleting it.
- Press **Save agent** (or **Create agent**).

## Skills

- Press **New skill**, or pick one from the list.
- **When should agents use it?**: agents load a skill when this matches their task. Start with
  "Use when…".
- **Skill instructions**: what to do, in Markdown. Add **Extra files** such as reference notes or
  scripts.
- Press **Save skill** (or **Create skill**). The built-in \`project-docs\` skill lets agents search
  the project documents.

## Try it

On any agent or skill, write a **Test task** and press **Run test** to see how it behaves. Test
runs appear under [Agent runs](#/help/runs).

## Shared library

**Save to shared library** makes an agent or skill available to every project. Open the
**Shared library** tab to add one to this project. Removing it from the library doesn't affect
projects that already have a copy.
`,
  },
  {
    id: 'team',
    title: 'Project and team',
    icon: 'user',
    body: `
**Project and team** holds the details agents read and who can do what. Only project owners can
change it.

## Details

- **Name** and **Description** of the project.
- **Project notes for agents**: conventions, constraints and links, for example "use the refunds
  table, never payments directly". These are added to the project's \`CLAUDE.md\`, which every
  agent reads first.

## Members

Under **Add a member**, enter the person's **Email** (they need a portal account; an admin
creates it under [Settings › Users](#/help/settings)), their **Role in the project** (for example
"Backend developer", which agents can see), and their **Access**: Viewer, Editor or Owner. Press
**Add member**. Members can be removed from the list later.

## Archive or delete

- **Archive project** hides it from lists and the switcher; **Restore project** brings it back.
- **Delete project** removes it with all its documents, runs and history. This can't be undone.
`,
  },
  {
    id: 'feedback',
    title: 'Feedback',
    icon: 'inbox',
    body: `
**Feedback** lets anyone signed in tell the portal admins what is broken, confusing or missing,
and follow what happens to it.

## Send feedback

1. Open **Feedback** from the menu. **Page it is about** is filled in with the page you came
   from; clear it if it isn't about a page.
2. Pick the kind: **Something is broken**, **Idea**, **Question** or **Other**.
3. Write a one-line **Summary** (optional) and the **Details**: what you did, what you expected,
   and what happened instead.
4. Press **Send feedback**.

## Your feedback

Lists what you sent, with its status: New, Accepted, In progress, In review, Approved, Fixed or
Declined, plus a link to the pull request once there is one.

## Inbox (admins)

- Filter by status, open an item, set its **Status**, and add **Your note** (not shown to the
  sender).
- **Send to agent**: pick the **Project** and the **Repository with the portal's code**, the
  branch, model and permission mode, then press **Start agent run**. The run always asks before
  changes, because feedback text comes from users.
- When the agent finishes, its work is pushed to a \`feedback/…\` branch, a pull request is opened
  on GitHub, and a code review starts. The item moves to **In review**.
- Under **Review the changes**, choose **Approve and merge**, **Send back to the agent** with
  your comments (the run continues with them and the open review findings), or
  **Reject changes** (closes the pull request).
`,
  },
  {
    id: 'account',
    title: 'Your account',
    icon: 'user',
    body: `
Click your name at the bottom of the menu to open **Your account**.

## Change your password

Enter your **Current password**, then the **New password** twice (at least 10 characters), and
press **Change password**.

If you forget your password, contact a portal admin.

## Sign out

Use the sign-out button next to your name at the bottom of the menu.
`,
  },
  {
    id: 'settings',
    title: 'Settings',
    icon: 'settings',
    adminOnly: true,
    body: `
**Settings** controls how agents reach Claude, what they may spend, and who can sign in. Only
admins see it.

## Model provider

- **Demo mode**: simulated agents, no cost.
- **Anthropic API**: paste an **Anthropic API key** from the Claude Console.
- **Amazon Bedrock**: set the **Region** and how the server signs in to AWS (see below). Enable
  the Claude models in the Bedrock console first.

Press **Test connection** after switching.

## AWS sign-in

Used for Amazon Bedrock and AWS CodeCommit repositories. Choose one:

- **Server's own AWS identity**: the instance or container role. No keys are stored.
- **Named profile**: a profile from the server's AWS config.
- **Access keys**: an access key ID, secret and optional session token.
- **Bedrock API key**.
- **AWS SSO (IAM Identity Center)**: enter the **SSO start URL** and **SSO region**, sign in with
  the code shown, then pick the **AWS account** and **IAM role**.

Press **Save AWS settings**.

## Model versions

If your account needs exact model IDs or Bedrock inference profiles, set them here and press
**Save model versions**.

## Agent defaults

- **Changes, unless a run says otherwise**: Ask before changes, Auto-accept edits, or Plan only.
- **Maximum turns per run**: stops runaway runs.

## Budget

Set a **Monthly cap in USD** and press **Save cap**. New runs are stopped once the month's spend
reaches it. Leave it empty for no cap. The month's spend shows at the bottom of the menu.

## Users

**Add user** creates an account with a **Name**, **Email** and **First password**. Tick
**Admin** to let them change settings and users. In the user list, the **Admin** switch changes
that later, and **Disable** / **Enable** blocks or restores someone's sign-in.

## Where secrets are stored

API keys and tokens are encrypted in the portal database, or kept in AWS SSM Parameter Store
under a **Parameter prefix**. They are never sent back to the browser. A **GitHub token** set
here is used for repositories that don't have their own.
`,
  },
];

export const HELP_BY_ID = Object.fromEntries(HELP_SECTIONS.map((s) => [s.id, s]));

/** Help section for the page a route points at, falling back to Getting started. */
export function helpSectionFor(route) {
  return HELP_BY_ID[route?.tab] ? route.tab : 'start';
}
