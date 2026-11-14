# Bundled skills and integrations

The portal ships three skills and two MCP presets taken from popular Claude Code plugins. The plugins themselves are not
installed (a cloud runner does not run `claude plugin install`); their content is.

## Skills (every project)

Each project gets these in `.claude/skills/<name>/` (`SKILL.md`, `LICENSE.txt`, `NOTICE.txt`), written once by
`ensureBundledSkills` (`server/bundled-skills.ts`): when a project is created, and for an existing project the first time a
session starts. A marker file (`.claude/skills/.bundled-skills.json`) records what was written, so a skill someone edited is
never overwritten and one they deleted does not come back. A skill folder that already has the same name is left alone.

| Skill | Source | Licence | What it does |
|---|---|---|---|
| `frontend-design` | `anthropics/claude-plugins-official`, `plugins/frontend-design` (unchanged) | Apache-2.0 | Guidance for distinctive, intentional UI design: aesthetic direction, typography, avoiding templated defaults, plan-then-critique |
| `caveman` | `JuliusBrussee/caveman`, `skills/caveman` (unchanged) | Apache-2.0 | Terse answers (answer first, no ceremony, technical facts kept); on until "stop caveman" or "normal mode" |
| `security-guidance` | adapted from `anthropics/claude-plugins-official`, `plugins/security-guidance` | Apache-2.0 | Security checks for code that runs commands, evaluates code, renders HTML, loads serialized data, configures crypto/TLS or edits GitHub Actions workflows |

`security-guidance` is different from the other two: the plugin is a Claude Code **hook** that warns while a file is being
edited (about 600 KB of Python with a model-based review). A runner cannot run Claude Code hooks, so the skill carries the
checks of the plugin's pattern list (`hooks/patterns.py`) as instructions the agent follows itself. It does not block or
warn automatically.

Like the Superpowers skills, a skill is used when an agent that lists it in its front matter (`skills: [caveman]`) runs, or when
someone starts a session with its command. Nothing is applied to a plain session by default, so `caveman` never changes how
sessions answer unless it is asked for.

To change a skill for one project, edit its `SKILL.md` under that project's `.claude/skills`. To update the bundled text for
everyone, change the originals and regenerate `server/bundled-skills.ts`.

## MCP presets (Integrations › Add)

| Preset | Address | Sign-in |
|---|---|---|
| **Context7** | `https://mcp.context7.com/mcp` | Optional API key (`Authorization: Bearer ...`); works without one at a lower rate limit |
| **Linear** | `https://mcp.linear.app/mcp` | OAuth: you sign in with Linear from the card that appears when a session starts (same flow as Atlassian) |

Leave **Allow writes** off for read-only use. The older Linear address `https://mcp.linear.app/sse` is deprecated.
