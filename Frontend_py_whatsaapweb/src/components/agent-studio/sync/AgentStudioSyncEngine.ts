import type {
  AgentStudioDocument,
  AgentGuidedConfig,
  AgentStudioNode,
  AgentStudioEdge,
} from '../types';

/**
 * Deterministic hash generator for frontend agent studio document.
 * Strips UI positions { x, y } to ensure invariance under canvas pan/move.
 */
export function computeStudioSpecHash(
  doc: Pick<AgentStudioDocument, 'entryNodeId' | 'nodes' | 'edges' | 'policyRef' | 'limits'>
): string {
  const canonicalNodes = [...doc.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      config: n.config ?? {},
    }));

  const canonicalEdges = [...doc.edges]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({
      id: e.id,
      from: e.sourceNodeId,
      to: e.targetNodeId,
      condition: e.conditionLabel ?? null,
      priority: e.priority ?? null,
    }));

  const canonicalPayload = JSON.stringify({
    entryNodeId: doc.entryNodeId,
    nodes: canonicalNodes,
    edges: canonicalEdges,
    policyRef: doc.policyRef,
    limits: doc.limits,
  });

  // Simple, deterministic 64-character hex hash for client-side SSOT
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < canonicalPayload.length; i++) {
    const ch = canonicalPayload.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  const part3 = ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0');
  const part4 = ((h1 + h2) >>> 0).toString(16).padStart(8, '0');
  return (part1 + part2 + part3 + part4 + part2 + part1 + part4 + part3).slice(0, 64);
}

/**
 * Compiles high-level Guided Wizard form state into the DAG graph topology
 * preserving existing node coordinates (x, y) and layout.
 */
export function guidedToGraph(
  guidedConfig: AgentGuidedConfig,
  existingDoc: AgentStudioDocument
): AgentStudioDocument {
  const nodeMap = new Map<string, AgentStudioNode>(
    existingDoc.nodes.map((n) => [n.id, n])
  );

  // 1. Update LLM reasoner node
  const llmNode = existingDoc.nodes.find((n) => n.kind === 'llm_reasoner');
  if (llmNode) {
    nodeMap.set(llmNode.id, {
      ...llmNode,
      label: `${guidedConfig.identity.name} (${guidedConfig.reasoning.model})`,
      config: {
        ...llmNode.config,
        provider: guidedConfig.reasoning.provider,
        model: guidedConfig.reasoning.model,
        temperature: guidedConfig.reasoning.temperature,
        maxTokens: guidedConfig.reasoning.maxTokens,
        systemPrompt: guidedConfig.reasoning.systemPrompt,
      },
      isDraftModified: true,
    });
  }

  // 2. Update memory retrieval node
  const memNode = existingDoc.nodes.find((n) => n.kind === 'memory_retrieval');
  if (memNode) {
    nodeMap.set(memNode.id, {
      ...memNode,
      config: {
        ...memNode.config,
        collectionId: guidedConfig.ragMemory.collectionId,
        topK: guidedConfig.ragMemory.topK,
        minSimilarity: guidedConfig.ragMemory.minSimilarity,
        includeChatHistory: guidedConfig.ragMemory.includeChatHistory,
      },
      isDraftModified: true,
    });
  }

  // 3. Update policy guard node
  const policyNode = existingDoc.nodes.find((n) => n.kind === 'policy_guard');
  if (policyNode) {
    nodeMap.set(policyNode.id, {
      ...policyNode,
      config: {
        ...policyNode.config,
        businessHoursEnabled: guidedConfig.policies.businessHoursEnabled,
        timezone: guidedConfig.policies.timezone,
        startTime: guidedConfig.policies.startTime,
        endTime: guidedConfig.policies.endTime,
        blockedKeywords: guidedConfig.policies.blockedKeywords,
        fallbackAction: guidedConfig.policies.fallbackAction,
        fallbackCannedText: guidedConfig.policies.fallbackCannedText,
      },
      isDraftModified: true,
    });
  }

  const updatedNodes = existingDoc.nodes.map((n) => nodeMap.get(n.id) || n);
  const updatedDoc: AgentStudioDocument = {
    ...existingDoc,
    name: guidedConfig.identity.name,
    description: guidedConfig.identity.description,
    nodes: updatedNodes,
    guidedConfig,
    isDirty: true,
    updatedAt: new Date().toISOString(),
    specHash: '',
  };

  const nextHash = computeStudioSpecHash(updatedDoc);
  return {
    ...updatedDoc,
    specHash: nextHash,
  };
}

/**
 * Projects DAG nodes & edges into high-level Guided Wizard form state.
 */
export function graphToGuided(
  nodes: readonly AgentStudioNode[],
  _edges: readonly AgentStudioEdge[],
  existingDoc: AgentStudioDocument
): AgentGuidedConfig {
  const currentGuided = existingDoc.guidedConfig;
  const llmNode = nodes.find((n) => n.kind === 'llm_reasoner');
  const memNode = nodes.find((n) => n.kind === 'memory_retrieval');
  const policyNode = nodes.find((n) => n.kind === 'policy_guard');
  const toolNodes = nodes.filter((n) => n.kind === 'tool_call');

  return {
    ...currentGuided,
    identity: {
      ...currentGuided.identity,
      name: existingDoc.name,
      description: existingDoc.description,
    },
    reasoning: {
      provider: (llmNode?.config?.provider as any) || currentGuided.reasoning.provider,
      model: (llmNode?.config?.model as string) || currentGuided.reasoning.model,
      temperature:
        typeof llmNode?.config?.temperature === 'number'
          ? llmNode.config.temperature
          : currentGuided.reasoning.temperature,
      maxTokens:
        typeof llmNode?.config?.maxTokens === 'number'
          ? llmNode.config.maxTokens
          : currentGuided.reasoning.maxTokens,
      systemPrompt: (llmNode?.config?.systemPrompt as string) || currentGuided.reasoning.systemPrompt,
    },
    ragMemory: {
      collectionId: (memNode?.config?.collectionId as string) || currentGuided.ragMemory.collectionId,
      topK: typeof memNode?.config?.topK === 'number' ? memNode.config.topK : currentGuided.ragMemory.topK,
      minSimilarity:
        typeof memNode?.config?.minSimilarity === 'number'
          ? memNode.config.minSimilarity
          : currentGuided.ragMemory.minSimilarity,
      includeChatHistory:
        typeof memNode?.config?.includeChatHistory === 'boolean'
          ? memNode.config.includeChatHistory
          : currentGuided.ragMemory.includeChatHistory,
      maxContextMessages: currentGuided.ragMemory.maxContextMessages,
    },
    toolsGranted: toolNodes.map(
      (t) => (t.config?.toolName as string) || (t.config?.name as string) || t.label
    ),
    policies: {
      businessHoursEnabled:
        typeof policyNode?.config?.businessHoursEnabled === 'boolean'
          ? policyNode.config.businessHoursEnabled
          : currentGuided.policies.businessHoursEnabled,
      timezone: (policyNode?.config?.timezone as string) || currentGuided.policies.timezone,
      startTime: (policyNode?.config?.startTime as string) || currentGuided.policies.startTime,
      endTime: (policyNode?.config?.endTime as string) || currentGuided.policies.endTime,
      blockedKeywords:
        Array.isArray(policyNode?.config?.blockedKeywords)
          ? policyNode.config.blockedKeywords
          : currentGuided.policies.blockedKeywords,
      fallbackAction: (policyNode?.config?.fallbackAction as any) || currentGuided.policies.fallbackAction,
      fallbackCannedText: (policyNode?.config?.fallbackCannedText as string) || currentGuided.policies.fallbackCannedText,
    },
  };
}

/**
 * Serializes AgentStudioDocument to clean YAML representation.
 */
export function toDeclarativeYaml(doc: AgentStudioDocument): string {
  const cleanPayload = {
    schemaVersion: doc.schemaVersion,
    graphId: doc.graphId,
    name: doc.name,
    version: doc.version,
    status: doc.status,
    entryNodeId: doc.entryNodeId,
    limits: doc.limits,
    policyRef: doc.policyRef,
    nodes: doc.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      config: n.config,
      position: n.position,
    })),
    edges: doc.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      conditionLabel: e.conditionLabel,
    })),
  };

  // Convert to formatted YAML-like string (or clean JSON with 2 spaces)
  return JSON.stringify(cleanPayload, null, 2);
}

/**
 * Parses Declarative YAML/JSON into an updated AgentStudioDocument
 * preserving existing coordinates when IDs match.
 */
export function fromDeclarativeYaml(
  text: string,
  currentDoc: AgentStudioDocument
): { doc?: AgentStudioDocument; error?: string } {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      return { error: 'El contenido debe ser un objeto YAML o JSON válido.' };
    }

    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      return { error: 'El grafo debe contener al menos un nodo en la lista "nodes".' };
    }

    const posMap = new Map<string, { x: number; y: number }>(
      currentDoc.nodes.map((n) => [n.id, n.position])
    );

    const mergedNodes: AgentStudioNode[] = parsed.nodes.map((n: any, idx: number) => {
      const existingPos = posMap.get(n.id) || n.position || { x: 80 + (idx % 4) * 240, y: 100 + Math.floor(idx / 4) * 140 };
      return {
        id: String(n.id || `node_${idx}`),
        kind: n.kind || 'agent',
        label: n.label || n.id,
        position: existingPos,
        config: n.config || {},
        inputs: n.inputs || ['in'],
        outputs: n.outputs || ['out'],
      };
    });

    const mergedEdges: AgentStudioEdge[] = Array.isArray(parsed.edges)
      ? parsed.edges.map((e: any, idx: number) => ({
          id: String(e.id || `edge_${idx}`),
          sourceNodeId: e.source || e.sourceNodeId,
          sourceHandle: e.sourceHandle || 'out',
          targetNodeId: e.target || e.targetNodeId,
          targetHandle: e.targetHandle || 'in',
          conditionLabel: e.conditionLabel,
        }))
      : [];

    const updatedDoc: AgentStudioDocument = {
      ...currentDoc,
      name: parsed.name || currentDoc.name,
      entryNodeId: parsed.entryNodeId || mergedNodes[0].id,
      nodes: mergedNodes,
      edges: mergedEdges,
      limits: parsed.limits || currentDoc.limits,
      policyRef: parsed.policyRef || currentDoc.policyRef,
      guidedConfig: graphToGuided(mergedNodes, mergedEdges, currentDoc),
      isDirty: true,
      updatedAt: new Date().toISOString(),
      specHash: '',
    };

    return {
      doc: {
        ...updatedDoc,
        specHash: computeStudioSpecHash(updatedDoc),
      },
    };
  } catch (err: any) {
    return { error: `Error de sintaxis: ${err.message}` };
  }
}
