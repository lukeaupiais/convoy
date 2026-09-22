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
  return {
    assertReady(connection) { credential(connection); },
    async probe(connection) {
      const data = await call(connection,
        'query($id: String!) { team(id: $id) { id name } }',
        { id: connection.teamId });
      if (data.team?.id !== connection.teamId) throw new Error('Linear team is unavailable to this credential.');
      return { teamName: data.team.name };
    },
    async createIssue(connection, ticket) {
      const data = await call(connection,
        'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url title } } }',
        { input: { teamId: connection.teamId, title: ticket.title, description: ticket.description } });
      const issue = data.issueCreate?.issue;
      if (!data.issueCreate?.success || !issue?.id || !issue?.identifier || !issue?.url) throw new Error('Linear did not confirm issue creation.');
      return { remoteId: issue.id, remoteKey: issue.identifier, url: issue.url };
    },
    async getIssue(connection, remoteId) {
      const data = await call(connection,
        'query($id: String!) { issue(id: $id) { id identifier url title description team { id } } }',
        { id: remoteId });
      return data.issue;
    },
    async updateIssue(connection, remoteId, fields) {
      const data = await call(connection,
        'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url title description } } }',
        { id: remoteId, input: fields });
      if (!data.issueUpdate?.success || data.issueUpdate.issue?.id !== remoteId) throw new Error('Linear did not confirm the issue update.');
      return data.issueUpdate.issue;
    },
    async listIssues(connection, limit) {
      const data = await call(connection,
        'query($id: String!, $first: Int!) { team(id: $id) { issues(first: $first) { nodes { id identifier url title description } } } }',
        { id: connection.teamId, first: limit });
      if (!data.team?.issues?.nodes) throw new Error('Linear team or issues unavailable.');
      return data.team.issues.nodes;
    },
  };
}
