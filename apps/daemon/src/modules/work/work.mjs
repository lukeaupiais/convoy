import { createCatalog } from './catalog.mjs';

const commands = [
  'saveProject',
  'createTicket',
  'createDevelopmentTicket',
  'linkDevelopmentTicket',
  'unlinkDevelopmentTicket',
  'saveTicketConnection',
  'deleteTicketConnection',
  'probeTicketConnection',
  'previewExternalTickets',
  'publishTicket',
  'reconcileTicketPublish',
  'syncExternalTicket',
  'syncExternalTicketThread',
  'postExternalTicketReply',
  'reconcileExternalTicketReply',
  'importExternalTickets',
  'saveTicketImportBinding',
  'syncTicketImportBinding',
  'updateTicket',
  'attachTicketFile',
  'removeTicketFile',
  'importTickets',
  'saveBoard',
  'deleteBoard',
  'saveBoardTemplate',
  'deleteBoardTemplate',
  'createBoardFromTemplate',
  'setBoardPlacement',
  'clearBoardPlacement',
];
const boardCommands = new Set([
  'saveBoard',
  'deleteBoard',
  'saveBoardTemplate',
  'deleteBoardTemplate',
  'createBoardFromTemplate',
  'setBoardPlacement',
  'clearBoardPlacement',
]);

/** Work owns projects, tickets, boards, and their optimistic revisions. */
export function createWork({ afterCommand = async (_command, result) => result, ...dependencies }) {
  const catalog = createCatalog(dependencies);
  return {
    id: 'work',
    commands,
    catalog,
    snapshot({ scope } = {}) {
      const value = catalog.snapshot();
      if (!scope) return value;
      const projectIds = new Set(scope.projectIds);
      return {
        projects: value.projects.filter((project) => projectIds.has(project.id)),
        tickets: value.tickets.filter((ticket) => projectIds.has(ticket.projectId)),
        ticketDevelopmentLinks: value.ticketDevelopmentLinks.filter((link) =>
          value.tickets.some((ticket) => ticket.id === link.supportTicketId && projectIds.has(ticket.projectId)) &&
          value.tickets.some((ticket) => ticket.id === link.developmentTicketId && projectIds.has(ticket.projectId)),
        ),
        ticketConnections: value.ticketConnections.filter((connection) =>
          value.projects.some((project) => projectIds.has(project.id) && project.organizationId === connection.organizationId),
        ),
        ticketImportBindings: value.ticketImportBindings.filter((binding) => projectIds.has(binding.projectId)),
        ticketImportMemberships: value.ticketImportMemberships.filter((membership) =>
          value.ticketImportBindings.some((binding) => binding.id === membership.bindingId && projectIds.has(binding.projectId))),
        ticketThreads: value.ticketThreads.filter((thread) => projectIds.has(value.tickets.find((ticket) => ticket.id === thread.ticketId)?.projectId)),
        ticketReplies: value.ticketReplies.filter((reply) => projectIds.has(value.tickets.find((ticket) => ticket.id === reply.ticketId)?.projectId)),
        boards: value.boards
          .filter(
            (board) =>
              (scope.includeUnowned && board.projectIds.length === 0) ||
              board.projectIds.some((projectId) => projectIds.has(projectId)),
          )
          .map((board) => ({
            ...board,
            projectIds: board.projectIds.filter((projectId) => projectIds.has(projectId)),
            tickets: board.tickets.filter((ticket) =>
              value.tickets.some(
                (candidate) =>
                  candidate.id === ticket.ticketId && projectIds.has(candidate.projectId),
              ),
            ),
          })),
        boardTemplates: value.boardTemplates,
      };
    },
    async command(command, context) {
      const result = await (boardCommands.has(command.action)
        ? catalog.boards.command(command)
        : catalog.command(command));
      return afterCommand(command, result, context);
    },
  };
}
