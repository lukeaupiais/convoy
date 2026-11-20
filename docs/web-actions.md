# Web interface actions

Every action the web interface offers, grouped by screen, with where it lives.

Use this list when changing the interface. A change that moves, hides or removes
a control updates this file in the same pull request, so no capability
disappears without a decision. Reviewers check that every action still has a
place.

Where an action lives:

- **Visible**: shown whenever the screen is open.
- **Menu**: inside a "⋯" or dropdown menu.
- **Dialog** or **panel**: inside a dialog, popover or settings panel.
- **Collapsed**: inside a disclosure that starts closed.
- **When …**: shown only in the stated state.

Escape closes the topmost dialog, menu or popover, and Tab stays inside an open
dialog. These keyboard rules apply everywhere and aren't repeated below.

## Shell

### Sidebar

- Convoy home (logo): visible.
- Projects, Chat, Workflows, Wiki: visible.
- Open a pinned ticket; Unpin: when tickets are pinned.
- Agents, Project settings, Integrations, Providers, Environments: visible.
- Collapse or expand the sidebar: visible on desktop.
- Open and close navigation, or tap the backdrop to close: on narrow screens.

### Top bar

- Needs attention (bell with a count): visible. Opens a list of items, each
  opening its conversation, ticket or workflow run.
- New ticket: on the board.
- New chat: on Chat.
- Choose project (search, pick, New project, Project settings): menu, on the
  board.
- Active context (project, accept an invitation, invite people, create a team):
  menu, on pages other than the board. Inviting and creating teams need the
  matching permission.

### Connection and errors

- Reconnect; Troubleshooting: when the connection is lost.
- Retry placement: when a ticket was created but couldn't be placed in its
  column.
- Pages have shareable links, and browser back and forward move between them.

## Board

### Header and toolbar

- Choose board (search, pick, New board): menu.
- Configure board: visible.
- Automations: visible. Opens a popover listing the board's workflow triggers,
  each opening its workflow.
- Board view or List view: visible.
- Filter tickets: visible.
- Sync from an import source: when the board is filtered to one enabled import.

### Columns and cards

- Open a ticket (click the card): visible.
- Drag a card to another column: visible, unless the ticket's source owns the
  field.
- Open the ticket in its external source: when the ticket is linked.
- Add a ticket to a column (+): visible, for boards that create Convoy tickets.
- Automations for a column: visible when the column has automations, otherwise
  in the column menu.

### List view

- Open a ticket; open it in its external source.
- Move a ticket with the column select: visible, unless the source owns the
  field.

### Board settings (panel)

- Board name, density, swimlanes, grouping and their fields.
- Imported ticket set, where new tickets are created, connections to include,
  Preview, Manage connections.
- Filters: ticket source, work type, search, status, labels, agents, priorities.
- New ticket work type.
- Columns: name, colour, field value, WIP limit, move left or right, delete, Add
  column.
- Card fields: title, priority, agent, custom fields (add, remove).
- Templates: choose, Save as template, Delete template.
- Delete board; Save board.

### New ticket (dialog)

- Project, Title, Description, Agent, Label.
- Create in a connection: when opened from a column on a board with
  connections.
- Create ticket.

## Ticket

The ticket opens as a dialog over the board, from a card, a pin or an attention
item.

### Header and menu

- Ticket options (⋯); Close ticket: visible.
- Pin to sidebar or Unpin: menu.
- Open chat, or one entry per linked conversation: menu.
- Execution details: menu.
- Pause workflow; Cancel workflow: menu, while a workflow runs.
- Open recovery details: menu, when the run needs recovery.
- Terminal, then Copy the attach command: menu, when an execution session
  exists.

### Details

- Edit (title, description, attachments, properties): visible.
- Add description: when the description is empty.
- Show more or Show less: when the description is long.
- Overview and Workflow tabs: when the ticket has a workflow run.
- Review workflow: when the run needs attention.
- Open an attachment, then Download: when files are attached.

### Conversation with the external source

- Choose the connection: when there's more than one.
- Refresh messages: when the source supports reading.
- Write a reply, Send reply, Cancel: when the source supports replies.
- Confirm which message was posted, or that none was: when a reply's outcome is
  uncertain.

### Sidebar

- Status, Priority, Agent: shown, changed in edit mode.
- Related tickets: open one; Add (link an existing ticket, or create and link a
  new one); Unlink (collapsed per row).
- Start workflow: when the ticket has no workflow run.
- Open in the external source: when linked (collapsed).
- Link the created issue, or confirm none was created: when publishing needs
  review.
- Compare content; Use Convoy values or Use the source's values: when sync
  failed.
- Publish to a connection: when the ticket isn't linked yet.

### Edit mode

- Title; Write or Preview the description; add and remove files.
- Properties (collapsed): Status, Assigned agent, Label, Priority.
- Custom fields (collapsed): edit, add, remove.
- Execution environment (collapsed): execution profile and placement, each with
  its own save.
- Cancel; Save.

### Workflow run

- Answer a question; Allow once, Always allow or Deny a tool: when the agent is
  waiting.
- Approve, Request changes (with feedback), Review action: when the run waits
  for approval.
- Fill in and save a human task response, then choose an outcome and decide:
  when a person must respond.
- Continue workflow; Rework activity: when the run waits to continue.
- Open recovery; Back to workflow: when the run is blocked.
- Open captured files or references, then browse, preview and download them:
  when the run produced them.
- Show full summary; Analysis, Additional output, Activity history
  (collapsed).
- Open the workflow run, child runs and results.

### Execution details

- Back to the ticket.
- Continue workflow: when the run is paused, interrupted, failed or waiting for
  submission.
- Claim control or Release control: when a session exists.
- Stop run: while the run is running or waiting.
- Answer a question: when the agent asks one outside a workflow.
- Reconcile an uncertain outcome (confirm the previous run stopped, confirm an
  effect applied or not), Retry an automation, Open ticket messages: when
  recovery is needed.
- Tools and skills: choose a capability profile, Apply profile, refresh
  workspace guidance (collapsed).
- Workspace, workflow and instructions (collapsed): session runner, session
  workflow, working directory, Apply configuration; read the effective
  instructions and workflow steps.
- Review changes and verification evidence, Refresh diff (collapsed).
- Reset the verification runtime: when it can be reset.
- Run this ticket or Run again (collapsed when a run exists): profile, workflow,
  session, environment, model, then Run ticket, Retry the same request or
  Change launch settings.

## Chat

### Conversation list

- Search chats; open a conversation: visible on wide screens, a select on narrow
  ones.
- New chat: in the top bar, or in the empty state. The dialog asks for the
  project and workspace.

### Header

- Conversation menu (⋯): Settings; open a related ticket.
- Review changes: when the session has a workspace with changes and the agent
  isn't running.
- Stop: while the agent runs.

### Messages

- Copy a message: on hover or focus.
- Copy code: on code blocks.
- Open links, linked tickets, delegated conversations and attachments.
- Latest activity: when new messages arrive while scrolled up.
- Show all: when filtered to one agent session.

### Composer

- Message; Enter sends and Shift+Enter adds a line.
- Send message, or Queue message while the agent runs.
- Steer now: while the agent runs.
- Chat model: visible, locked while the agent runs.
- Model usage: when usage data exists.
- Attach files or images, a workspace file, by drag and drop or by pasting; remove
  an attachment.
- Remove a queued message: when messages are queued.
- Resume, after confirming the interrupted operation was inspected: when the
  agent stopped.
- Connect a provider: when none is connected.
- Review workflow or Hide workflow: when messaging waits on a workflow. Opens the
  same workflow run actions as the ticket.

### Tool activity and approvals

- Expand completed tools; expand a tool card; Raw details.
- Stop a running command.
- Read retained output, page through it.
- Allow once, Always allow, Deny: when a tool waits for approval.
- Answer the agent's question: when it asks one.

### Change review (dialog)

- Refresh; Close.

### Chat settings (dialog)

- Session runner, session workflow, working directory; Apply.
- Confirm the previous execution stopped; reconcile workflow effects; Retry
  automations: when recovery is needed.
- Advanced (collapsed): session capabilities, effective instructions, workflow
  steps, review changes and verification evidence, Test model access, inspect an
  agent session, diagnostics.

### Live sessions

The page has no sidebar entry. It opens from its link (`#/sessions`).

- Filter by project; History or Current work; open a session.
- Open the ticket or run behind a failed start or an uncertain outcome.

## Workflows

### List and workflow

- New workflow; open a workflow: on the list.
- Run workflow: on a published workflow. The start form asks for the project,
  workflow and run inputs.
- Workflow actions (⋯): Edit workflow, Automations.
- Back to workflows.

### Editor

- Select a workflow or draft; New workflow from a template (Team delivery, Small
  change, Bug fix, Blank).
- Stages or Graph view.
- Apply changes (publish): when a saved draft is pending. Drafts save
  automatically.
- Workflow options (⋯): Settings; Copy to this project (organisation workflows);
  Reorder (stages); Layout and Fit graph (graph).
- Settings panel: name, verification runtime, capability profile, run input
  schema, result schemas (collapsed), entry step, revisions, use as default.
- Stages: select a stage, add a step after it or the first step, reorder by drag
  or move up and down.
- Graph: add a node from the palette, zoom, fit, pan, move nodes, select nodes
  and routes, connect an outcome to a node, pick a node from a list on narrow
  screens.
- Node inspector: title, instructions, advance mode, required document, connect
  an outcome, Delete node. Each node type adds its own settings (agent, check,
  approval, action, branch, wait for event, child, parallel and map workflows).
- Route inspector: from, to, outcome; Delete route.

### Automations

- New automation; New schedule.
- Open an automation to edit it: name, project, trigger event and scope,
  conditions, workflow and inputs, concurrency, Enabled; Save or Cancel.
- Schedule form: name, project, workflow and inputs, interval or calendar
  timing, missed runs; Save schedule or Cancel. Schedules are listed but can't
  be edited after creation.

### Runs

- Open a run or its chat.
- Continue: when the run allows it.
- Cancel run: while the run isn't finished.
- Approve or Request changes: when a run waits on a person.
- View or Refresh the result: when the run completed with a result.
- Diagnostics, Activity history, Decision history (collapsed); child runs.

## Wiki

### Navigation

- Search the wiki, with scope; open results; More results; Close search.
- New page: when the collection is active.
- Choose a collection; Overview; open a page.
- Manage (collapsed): Show drafts, Show archived, New collection, Collection
  settings.

### Page

- Edit.
- Page actions (⋯): Copy link, read an older revision, Archive page.
- Read the latest version: when viewing an older one.
- On this page, Related pages, Referenced by, Details.
- Return to overview: when a page fails to open.

### Editor

- Title; Write or Preview; insert a page link (collapsed); page details:
  aliases, language, applies to (collapsed).
- Cancel (asks before discarding), Save draft, Publish; Restore page when
  archived.

### Collection settings

- Name, introduction, starting pages and their order.
- Save collection; Archive or Restore collection (collapsed).

## Settings

### Project settings

- Choose the project; create a project; import tickets saved in this browser
  (when there are any).
- Name, description, default verification runtime; Save project.
- Publish a verification runtime revision (collapsed).
- Agent profile for new sessions; default execution profile and placement, each
  with its own save.
- Instructions: New instruction, open one, Other scopes; the editor sets name,
  scope, target and content, imports a file and publishes a version.

### Agents

- Profiles and Skills tabs.
- Profiles: find, New profile, open; per profile (⋯) Export and revision
  history; remove saved approval rules.
- Profile editor: name; tools, extensions, skills and skill sources (each
  collapsed); Advanced: ID, load the workspace AGENTS.md, knowledge
  collections; Save profile or Cancel.
- Skills: find, filter by scope and runner, New skill, more actions (⋯) to
  import files or a folder and refresh; open a skill or bundle.
- Skill editor: destination, files (add, remove, edit, download), reload or
  compare changed sources, export a bundle, copy to a folder, confirm review,
  Save skill or Cancel; inspect and reconcile an uncertain save.

### Integrations

- Connections and Plugins & MCP tabs.
- Per connection: enable; sync interval, Sync, pause or enable import; bind an
  import; edit (⋯): Test, Disable, name and settings, Save, Delete.
- Add a Linear connection or a custom ticket source (collapsed).
- Register an extension after reviewing its manifest; read a registered
  manifest.

### Providers

Administrators only, except the personal subscription.

- Per connection: Probe, rotate the credential, revoke the credential or the
  connection.
- Add a connection; create a route (after a probe finds models).
- Personal subscription (collapsed): Sign in, Disconnect.

### Environments

- Connect a remote workspace; add and edit environments; register and edit
  runners, Refresh health; create and edit runner pools (each collapsed).
- Maximum parallel executions; Save capacity.
- Skill directories: register a directory; trust, read and edit access;
  unregister; copy a snapshot to a runner; inspect and reconcile an uncertain
  copy.
