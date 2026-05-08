import type { RetrievedChunk } from "../types.js";
import type { KnowledgeSearch } from "./knowledgeSearch.js";

export class EmptyKnowledgeSearch implements KnowledgeSearch {
  async search(): Promise<RetrievedChunk[]> {
    return [];
  }
}
