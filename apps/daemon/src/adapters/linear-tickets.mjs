const endpoint = 'https://api.linear.app/graphql';

function credential(connection) {
  const value = process.env[connection.credentialEnv];
  if (!value) throw new Error(`Linear credential ${connection.credentialEnv} is unavailable.`);
  return value;
}

async function graphql(connection, query, variables, fetcher = fetch) {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: credential(connection) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Linear request failed (${response.status}).`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`Linear rejected the request: ${body.errors[0].message}`);
  if (!body.data) throw new Error('Linear returned no data.');
  return body.data;
}

export function createLinearTickets({ fetcher = fetch } = {}) {
  const call = (connection, query, variables) => graphql(connection, query, variables, fetcher);
  const normalize = (issue) => issue && ({
    remoteId: issue.id,
    remoteKey: issue.identifier,
    url: issue.url,
    title: issue.title,
    description: issue.description ?? '',
    remoteVersion: issue.updatedAt ?? `${issue.title}\n${issue.description ?? ''}`,
    fieldOwnership: { title: 'external', description: 'external' },
    ...(issue.team ? { sourceScope: issue.team.id } : {}),
  });
  return {
    assertReady(connection) { credential(connection); },
    async probe(connection) {
      const data = await call(connection,
        'query($id: String!) { team(id: $id) { id name } }',
        { id: connection.teamId });
      if (data.team?.id !== connection.teamId) throw new Error('Linear team is unavailable to this credential.');
      return { sourceName: data.team.name, teamName: data.team.name, itemCount: undefined };
    },
    async createIssue(connection, ticket) {
      const data = await call(connection,
        'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url title } } }',
        { input: { teamId: connection.teamId, title: ticket.title, description: ticket.description } });
      const issue = data.issueCreate?.issue;
      if (!data.issueCreate?.success || !issue?.id || !issue?.identifier || !issue?.url) throw new Error('Linear did not confirm issue creation.');
      return normalize(issue);
    },
    async getIssue(connection, remoteId) {
      const data = await call(connection,
        'query($id: String!) { issue(id: $id) { id identifier url title description updatedAt team { id } } }',
        { id: remoteId });
      return normalize(data.issue);
    },
    async updateIssue(connection, remoteId, fields) {
      const data = await call(connection,
        'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url title description } } }',
        { id: remoteId, input: fields });
      if (!data.issueUpdate?.success || data.issueUpdate.issue?.id !== remoteId) throw new Error('Linear did not confirm the issue update.');
      return normalize(data.issueUpdate.issue);
    },
    async listIssues(connection, limit) {
      return (await this.listIssuesPage(connection, limit)).items;
    },
    async listIssuesPage(connection, limit, cursor) {
      const data = await call(connection,
        'query($id: String!, $first: Int!, $after: String) { team(id: $id) { issues(first: $first, after: $after) { nodes { id identifier url title description updatedAt } pageInfo { hasNextPage endCursor } } } }',
        { id: connection.teamId, first: limit, after: cursor ?? null });
      if (!data.team?.issues?.nodes) throw new Error('Linear team or issues unavailable.');
      const { nodes, pageInfo } = data.team.issues;
      if (pageInfo?.hasNextPage && (!pageInfo.endCursor || !nodes.length)) throw new Error('Linear returned an invalid next page.');
      return { items: nodes.map(normalize), nextCursor: pageInfo?.hasNextPage ? pageInfo.endCursor : undefined };
    },
  };
}
