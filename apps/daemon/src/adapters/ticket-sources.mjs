export function createTicketSources(adapters) {
  function adapter(connection) {
    const value = adapters[connection?.provider];
    if (!value) throw new Error(`Ticket source provider ${connection?.provider ?? 'unknown'} is unavailable.`);
    return value;
  }
  return {
    validateConnection(connection) { return adapter(connection).validateConnection?.(connection); },
    assertReady(connection) { return adapter(connection).assertReady?.(connection); },
    probe(connection) { return adapter(connection).probe(connection); },
    listIssues(connection, limit) { return adapter(connection).listIssues(connection, limit); },
    async listIssuesPage(connection, limit, cursor) {
      const value = adapter(connection);
      return value.listIssuesPage ? value.listIssuesPage(connection, limit, cursor) : { items: await value.listIssues(connection, limit) };
    },
    getIssue(connection, remoteId) { return adapter(connection).getIssue(connection, remoteId); },
    listComments(connection, remoteId) {
      const value = adapter(connection);
      if (!value.listComments) throw new Error('This ticket source does not provide a thread.');
      return value.listComments(connection, remoteId);
    },
    postReply(connection, remoteId, body, requestId) {
      const value = adapter(connection);
      if (!value.postReply) throw new Error('This ticket source does not support replies.');
      return value.postReply(connection, remoteId, body, requestId);
    },
    setStatus(connection, remoteId, input) {
      const value = adapter(connection);
      if (!value.setStatus) throw new Error('This ticket source does not support status writes.');
      return value.setStatus(connection, remoteId, input);
    },
    createIssue(connection, ticket) {
      const value = adapter(connection);
      if (!value.createIssue) throw new Error('This ticket source is read-only.');
      return value.createIssue(connection, ticket);
    },
    updateIssue(connection, remoteId, fields) {
      const value = adapter(connection);
      if (!value.updateIssue) throw new Error('This ticket source is read-only.');
      return value.updateIssue(connection, remoteId, fields);
    },
  };
}
