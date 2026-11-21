# Flows (recipes)

A flow is a recipe that coordinates several agent sessions on work too big for one: design, build, test, review. Each
step runs in its own session with fresh context, so a reviewer does not inherit the builder's reasoning. It is the
portal's counterpart of Kiro's workflows (https://kiro.dev/docs/workflows/) and works in Kiro, Claude Code and Codex
sessions.

## Where recipes live

Agent setup, in the folder of the engine: `kiro/workflows/<name>.yaml`, `claude/workflows/<name>.json`, and so on.
YAML and JSON both work.

## Two kinds of recipe

| Kind | What it is | Who runs it |
|---|---|---|
| **portal** | A `steps` list where each step has a `prompt` (below) | The portal, on any engine. Each step is a child session. |
| **native** | Any other recipe in a Kiro session, such as one written for Kiro's own workflow feature | The Kiro agent. It gets the recipe text and runs it itself. |

A portal recipe can ask for Kiro to run it instead with `runner: kiro`.

## Portal recipe format

```yaml
name: feature-pipeline
description: Design, build and review a change
steps:
  - id: design
    prompt: "Design this change: {{input}}"
  - id: build                      # waits for "design" (the step before, when `needs` is left out)
    prompt: "Implement this design:\n{{steps.design.result}}"
  - id: tests
    needs: [design]                # same `needs` as "build": the two run side by side
    prompt: "Write tests for:\n{{steps.design.result}}"
  - id: review
    needs: [build, tests]
    agent: code-review-agent       # optional: a custom agent for this step's session
    prompt: "Review the work. End with APPROVED or CHANGES NEEDED."
    until: APPROVED                # run again, with the last answer, until the answer has this text ...
    maxRuns: 3                     # ... or this many runs have been made (default 3, at most 10)
```

- `{{input}}` is what was typed after the recipe name; `{{steps.<id>.result}}` is the last message of a step you wait for.
- At most 20 steps. A step that is never reached because another failed is skipped; a failed step fails the flow
  and stops the steps still running.
- The delegation limits (Admin › Delegation) apply: with the default of 3 running children per session, a fourth parallel
  step waits until one ends.

## Running a flow

- Chat: `/flow` lists the recipes, `/flow run <name> [input]` runs one, `/flow status` and `/flow stop` follow and stop it.
- The **Flow** strip above the conversation shows the steps and their status, with a Run picker and Stop.
- API: `GET /api/projects/:id/workflows/:wid/flow`, `POST …/flow/run {name, input}`, `POST …/flow/stop`.

One flow runs per session at a time; the state of the last one stays with the session (`p6_workflows.flow_state`).

## How it works

`server/flows/`: `recipe.ts` parses and checks a recipe, `state.ts` decides what runs next (pure), `engine.ts` starts the
steps as child sessions (`delegation.ts`) and moves the flow on when one finishes, `catalog.ts` finds the recipes,
`command.ts` is `/flow`. The state is kept in the session, so nothing waits in memory.

Not covered yet: recipes inside a repository (`.kiro/workflows/` of a cloned repo) are not listed by the portal — only
the Agent setup folder is. Kiro itself finds the repository ones when you ask it to run a workflow in plain words.
