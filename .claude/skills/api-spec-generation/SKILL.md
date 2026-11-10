---
name: api-spec-generation
description: Turn a client's API documentation (Word, Excel, PDF or notes, in any layout) into an OpenAPI 3 JSON specification that the portal's API simulation imports. Use when asked to create, extract, update or review an API specification from a document.
---

# Generating an API specification from a document

The portal's **API simulation** (Tests > API simulation) imports an OpenAPI 3 JSON file and stands in for the client's API until the real one exists. Client documents differ from project to project, so there is no fixed layout to rely on: read the document, work out the APIs, and write the spec. If the client already has an OpenAPI file or a Postman collection, do not use this skill: import it directly.

## Tools in this repo

Run from the repository root.

| Command | What it does |
|---|---|
| `node --import tsx scripts/api-spec/doc-to-markdown.mts <file>` | Outline of a `.docx`, `.xlsx` or `.pdf`: numbered sections with title, size and the start of their text |
| `... doc-to-markdown.mts <file> --sections 3,4,5` | The full text of those sections |
| `... doc-to-markdown.mts <file> --all` | The whole cleaned document (only for short ones) |
| `node --import tsx scripts/api-spec/validate-spec.mts <spec.json> [--cases]` | Checks the spec the way the portal reads it; `--cases` also runs the generated test cases through the mock engine |
| `node --import tsx scripts/api-spec/import-to-portal.mts <spec.json> --project <id> --group "<name>" [--label v1.9] [--dry-run]` | Sends the spec to the portal as drafts. Changes a shared system: only when the person asked |

`example-spec.json` next to this file shows the target shape.

## Process

1. **Outline.** Run the outline command. From the titles and snippets decide which sections hold general information (base URLs, authentication, common headers, status codes, code or value lists) and which describe each API. One API is one HTTP operation: a method and a path. Ignore cover pages, revision history, diagrams and process flows.
2. **Read one API at a time.** Fetch the sections of that API with `--sections`, plus the general-information sections. Do not read the whole document into one pass when it is long.
3. **Write the operation** (rules below) into one spec file per API group. A *group* is the client or document the APIs came from; each import names one.
4. **Validate.** Run `validate-spec.mts <file> --cases`. Fix every ERROR. Read the warnings: each one is something the person must still decide, and they are shown in the portal with an exclamation icon.
5. **Report.** Say how many APIs were written, which assumptions you made, which warnings remain, and which questions the client has to answer. Offer the import; do not run it unasked.

## What goes into the spec

- **operationId**: camelCase from the API's name in the document. When updating an earlier spec, keep the operationIds it already has: mock rules and the version diff follow them.
- **path**: exactly as the document writes it, with a leading `/`, without the host, and `{id}` for path parameters. Never invent one. If the document gives none, use `/<operationId>` and add a `MISSING_PATH` flag.
- **method**: as written. If it is not stated, say so in a flag rather than guessing silently.
- **Authentication**: a bearer token or "Authorization: Bearer ..." means `"security": [{"bearerAuth": []}]` plus `components.securitySchemes.bearerAuth` (`type: http`, `scheme: bearer`). Other schemes: no `security`, and an `AUTH_OTHER` flag.
- **Headers** go in `parameters` with `in: header`, except Content-Type, Accept and Authorization. **Query strings** go in `parameters` with `in: query`. For a GET, request fields are query parameters, not a body.
- **Request body**: `requestBody.content["application/json"].schema` with `properties`. Nested tables ("X Object") become nested `properties`; a list of objects is `type: array` with `items`.
- **Types**: String/Text/Varchar to `string`; Numeric/Decimal/Float to `number`; Int/Integer/Long to `integer`; Boolean to `boolean`; Object/Map to `object`; List/Array to `array`; dates stay `string`.
- **Required**: only what the document says. Mandatory/M/Required means listed in `required`; Optional/O means not. If the document says nothing about requiredness, list nothing and add a `REQUIRED_UNKNOWN` flag. Never assume "all fields required".
- **Lengths and values**: a length is `maxLength`; a list of valid values, even one hidden in a remark, is `enum`.
- **Rules in words** ("mandatory when action = 142"): the field is not required; put the text in `x-conditional` on that field and add a `CONDITIONAL_RULE` flag. The portal can later turn these into enforced checks, with a person's confirmation.
- **Responses**: every sample answer or error in the document is a `responses` entry keyed by its HTTP status (the `StatusCode` the sample shows). Put the field schema and the sample as `example` on the success response; error samples keep their `example`. Always include a 2xx response; without one the simulation has nothing to answer with.

## Flags

Add `x-flags` to the operation (an array of `{code, severity, message}`) for everything a person should check. Use the portal's codes so the screen treats them the same way:

`AI_EXTRACTED` (info, once per operation: "Read from the document by an agent. Check ..."), `MISSING_PATH`, `NO_METHOD`, `REQUIRED_UNKNOWN`, `TYPE_ASSUMED`, `CONDITIONAL_RULE`, `SCHEMA_INFERRED`, `NO_RESPONSE`, `ERROR_SAMPLES` (info), `AUTH_OTHER`, `AUTH_UNKNOWN` (info), `AI_NOTE` (info: anything unclear or contradictory in the document). Severity `warning` shows the exclamation icon; `info` does not.

## Never

- Invent a field, path, type, limit or value that the document does not contain. Unknown means "not stated": omit it and flag it.
- Resolve a contradiction silently. Pick the reading the document supports most, and add an `AI_NOTE` saying what conflicted.
- Run the import, or put real secrets, tokens or personal data from the document into the spec or the report.

## Updating from a newer document

Read the new document the same way, then reuse the operationIds from the earlier spec file for APIs that match by method and path. Import it into the **same group** to add a new version (give a `--label` such as the document's version); the portal shows what changed between the versions. A different group name keeps a separate copy instead.
