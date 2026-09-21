export type ContextFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  source?: { path: string; runnerId: string; workspace: string };
  at: string;
};
