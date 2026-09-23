# Board integrations: product and behavior spec

Status: Linear first slice implemented; remaining platforms and background sync
are future work. This document states the intended complete behavior.

## Current Linear setup

An organization administrator adds a Linear connection on the **Integrations**
page with a name, Linear team UUID, and a credential environment
variable such as `CONVOY_LINEAR_TOKEN_MAIN`. Set that variable in the daemon
environment to a Linear API key with access to the selected team, then restart
the daemon. Convoy stores
the variable name, never the key. Test, edit, disable, or delete unused
connections there. Enable a connection as a destination in Board settings,
then choose **Convoy only**, **Ask each time**, or **Create in [connection]**.

The current connector imports team issues on demand through a project import
binding, creates issues
when selected, and sends title and description edits on tickets created by
Convoy. Imported tickets take title and description from Linear. Conflicting
remote edits are shown on the ticket for explicit resolution. A remote creation
with an uncertain outcome must be reconciled before another attempt. Webhooks,
scheduled polling, other fields, OAuth, and Azure DevOps/Asana adapters
are not implemented yet.

An import binding selects a connection, destination project, and work type.
Its cursor is saved after each imported page and a completed scan updates its
membership set. Boards select tickets by project, work type, and optionally an
import binding. Several boards can show the same ticket. A source can be bound
to one project; use separate connections for distinct remote source scopes.
Creating a board or adding a ticket to a board does not create an import binding.

## Goal

Let people work with Convoy tickets and tickets from Azure DevOps, Asana,
Linear, or a custom project management platform on the same board. Make each
ticket's external relationship visible without making board membership an
instruction to publish it externally.

## Domain rules

- A Ticket remains the authoritative Convoy work item. A Board is a view of
  tickets, and one ticket may appear on multiple boards. Moving or showing a
  ticket on a board does not create an external item.
- A ticket's **origin** records how it first entered Convoy. An **external
  link** records an association with a particular external item. These are
  different facts: a ticket created in Convoy and later published to Linear
  retains its origin and gains a Linear link.
- An external link identifies a configured connection and remote item, not
  merely a provider name. Two Linear workspaces, for example, are distinct
  destinations. The link retains the remote ID and URL even if the board changes.
- A board's default destination controls creation through that board only. It
  does not change existing tickets, their links, or creation through other
  surfaces. A ticket linked to one source never switches source because it
  appears on another board.
- Remote creation requires an explicit choice by the user or an enabled board
  rule. The default for a board without such a rule is **Convoy only**.
- Provider credentials and sync authority belong to a governed connection.
  Board access alone does not grant permission to publish to that connection.

## Board experience

### Cards

- Show a compact provider label, such as **Linear ↗**, on a card with an
  external link. Opening it goes to the external item. For multiple links, show
  the primary link and a compact indication of the others.
- Show no source badge on a local-only ticket.
- Show an attention indicator only when sync needs action. A healthy link
  should not add recurring status text to every card.
- Board columns, filters, and placement continue to mean what they mean today.
  A column move affects an external field only when a configured field mapping
  explicitly says so. Local board placement alone is not a remote update.

### Creating a ticket

- **New ticket** opens the normal ticket form. Near Save, show **Create in:**
  with the resolved destination: **Convoy only** or a named connection such as
  **Linear · Product team**.
- Offer only destinations available to this board and authorized for this user.
  If there is one choice, keep the selector compact; do not add an extra step.
- The board default preselects the destination. The user can override it for
  that ticket when permitted. The primary action names the effect: **Create
  ticket** for Convoy only, or **Create in Linear** for remote creation.
- If remote creation fails, show the real outcome on the ticket or form. Never
  claim the remote item exists until its identity has been read back. An
  uncertain result must be reconciled before a retry can create another item.

### Board settings

An **Integrations** section shows connected sources used by the board and one
simple rule: **New tickets on this board:**

1. **Convoy only** (default).
2. **Ask each time** (the destination is required in the creation form).
3. **Create in [connection]** (preselected, with an override when permitted).

The section provides **Configure sync** for import scope, field mapping, and
direction. Those controls stay out of the main board view. If a selected
connection is revoked or unavailable, creation falls back to an explicit
choice or blocks with a clear explanation; it must not silently publish
somewhere else.

### Ticket detail

- Show the linked platform, remote key, and outbound link near the title, for
  example **Linear · LIN-123 ↗**.
- A local-only ticket may offer **Publish to…** to create a remote item and add
  a link. The action previews the destination and fields that will be sent.
- A sync error or conflict offers **Review sync issue**. Show the affected
  fields, each side's value, and the action needed to resolve it. Avoid a
  generic success state that hides a pending or failed sync.
- Disconnecting a link requires a separate, explicit action. Deleting a board
  or removing a ticket from it does not delete either ticket or remote item.

## Sync behavior

- Import is scoped to selected projects, teams, or queries within a connection.
  Repeated import of the same remote item updates the existing linked ticket;
  it does not create duplicates. Import never changes an existing ticket's
  origin merely because it was seen again.
- Publishing a local ticket creates one remote item and records its identity.
  Retrying the same request cannot create a second item. The system tracks
  pending, confirmed, failed, and outcome-unknown effects durably.
- Field mappings specify which fields transfer and who owns each field. A
  remote-owned field is not silently overwritten by a local edit, and a
  Convoy-owned field is not silently overwritten by an incoming event. A
  conflict is visible and resolvable at the ticket.
- Sync is based on ticket fields and external links, rather than board
  placement. A field-backed board move can produce a mapped ticket-field
  change; a local board move does not.
- Sync records the last confirmed remote version or equivalent cursor and
  enough history to explain the most recent attempted change. Duplicate and
  out-of-order external events must be safe to process.
- Removing an integration or losing authorization does not erase Convoy
  tickets or links. It stops future sync and shows the connection state.

## Scope and decisions to refine

The first release should support one external link per ticket, one configured
connection as a board's creation default, import, explicit publish, mapped
updates, and visible sync repair. The model should leave room for multiple
links later without making them a requirement for the first release.

Before implementation, decide:

1. Which platform is first, and which remote fields and object types are in
   scope for it?
2. May users override a board's configured destination, or can an
   administrator lock it?
3. Which fields are Convoy-owned, remote-owned, or explicitly two-way? How are
   conflicts resolved for each?
4. Does **Create in [connection]** create the Convoy ticket immediately while
   remote creation completes, or wait for confirmed remote creation?
5. What should happen when a remote item is deleted or moved outside the
   configured import scope?
6. Which organization or project roles may configure connections, imports,
   mappings, defaults, and manual publishing?

## Acceptance scenarios

1. A board contains imported Linear tickets. A user creates a ticket with
   **Convoy only** selected. It appears on the board with no Linear link, and
   no Linear item is created.
2. The board default is **Create in Linear**. The creation form names that
   destination; after confirmed creation, the ticket displays the remote key
   and link. A repeated request yields the same linked ticket and remote item.
3. A ticket appears on two boards. Changing either board's creation default
   leaves the ticket's origin and external links unchanged.
4. A user moves a ticket on a local board. No external update is sent. A move
   on a field-backed board sends an update only when that ticket field is mapped
   for outgoing sync.
5. Remote creation times out after submission. The UI shows an uncertain
   outcome; retry waits for reconciliation and cannot produce a duplicate.
6. A conflicting remote edit appears on the ticket with both values and a
   resolution action. The board remains usable while that ticket needs review.
7. A connection is revoked. Existing tickets and links remain visible; new
   publishing through it is unavailable and the reason is clear.

## Ownership and integration boundary

Work owns tickets, boards, external link facts, and ticket-level decisions.
The control plane coordinates durable sync work and permissions. Provider
adapters translate the normalized operations to Azure DevOps, Asana, Linear,
or a custom platform. HTTP and web presentation do not decide sync policy.
Shared contracts carry data shapes only. External effects need durable
idempotency and reconciliation consistent with Convoy's existing handling of
uncertain mutations.
