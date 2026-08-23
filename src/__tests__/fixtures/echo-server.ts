import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const marker = process.env.METAMCP_FIXTURE_START_MARKER;
if (marker) appendFileSync(marker, `${process.pid}\n`);

const server = new Server(
  { name: 'metamcp-echo-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const listMarker = process.env.METAMCP_FIXTURE_LIST_MARKER;
  if (listMarker) appendFileSync(listMarker, 'listed\n');
  return { tools: [
    {
      name: 'echo',
      description: 'Echo a value',
      inputSchema: {
        type: 'object',
        properties: { value: {} },
        required: ['value'],
      },
    },
    {
      name: 'upper',
      description: 'Uppercase a string',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    {
      name: 'mutate_then_exit',
      description: 'Fixture that records a mutation and exits before replying',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'hang',
      description: 'Fixture that never replies',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'fail',
      description: 'Fixture that returns an application-level error',
      inputSchema: { type: 'object', properties: {} },
    },
  ] };
});

server.setRequestHandler(CallToolRequestSchema, async request => {
  const value = request.params.arguments?.value;
  if (request.params.name === 'echo') {
    return {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: { value },
    };
  }
  if (request.params.name === 'upper') {
    const upper = String(value).toUpperCase();
    return {
      content: [{ type: 'text', text: upper }],
      structuredContent: { value: upper },
    };
  }
  if (request.params.name === 'mutate_then_exit') {
    const mutationMarker = process.env.METAMCP_FIXTURE_MUTATION_MARKER;
    if (mutationMarker) appendFileSync(mutationMarker, 'mutated\n');
    setImmediate(() => process.exit(91));
    return new Promise<never>(() => undefined);
  }
  if (request.params.name === 'hang') {
    return new Promise<never>(() => undefined);
  }
  if (request.params.name === 'fail') {
    return {
      content: [{ type: 'text', text: 'fixture application error' }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Unknown fixture tool: ${request.params.name}` }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
