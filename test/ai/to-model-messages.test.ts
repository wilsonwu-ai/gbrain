import { describe, expect, it } from 'bun:test';
import { toModelMessages, type ChatMessage } from '../../src/core/ai/gateway.ts';

// v0.42 AI SDK v6 fix: the gateway boundary adapter that converts gbrain's
// provider-neutral ChatMessage[] into AI SDK v6 ModelMessage[]. This is the
// single place that knows the v6 wire shape, so toolLoop stays provider-neutral.
describe('toModelMessages (AI SDK v6 boundary adapter)', () => {
  it('passes string-content messages through unchanged', () => {
    const out = toModelMessages([{ role: 'user', content: 'hello' }]);
    expect(out).toEqual([{ role: 'user', content: 'hello' }] as any);
  });

  it('keeps assistant text + tool-call blocks (input, not args)', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } },
        ],
      },
    ];
    const out = toModelMessages(msgs) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(out[0].content[0]).toEqual({ type: 'text', text: 'calling' });
    expect(out[0].content[1]).toEqual({
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'search',
      input: { q: 'foo' },
    });
  });

  it('moves tool-result blocks onto a role:tool message with output:{type:json,value}', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user', // internal toolLoop role; must become 'tool' at the SDK boundary
        content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'search', output: { ok: true } }],
      },
    ];
    const out = toModelMessages(msgs) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('tool');
    expect(out[0].content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'tc1',
      toolName: 'search',
      output: { type: 'json', value: { ok: true } },
    });
    // v6 has no isError field on ToolResultPart — it must not leak through.
    expect(out[0].content[0]).not.toHaveProperty('isError');
  });

  it('encodes errors via output:{type:error-text}, dropping isError', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'tc1', toolName: 'search', output: 'boom', isError: true },
        ],
      },
    ];
    const out = toModelMessages(msgs) as any[];
    expect(out[0].role).toBe('tool');
    expect(out[0].content[0].output).toEqual({ type: 'error-text', value: 'boom' });
    expect(out[0].content[0]).not.toHaveProperty('isError');
  });

  it('normalizes undefined success output to null (JSON-safe)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 't', output: undefined }] },
    ];
    const out = toModelMessages(msgs) as any[];
    expect(out[0].content[0].output).toEqual({ type: 'json', value: null });
  });

  it('falls back to String() for unserializable (cyclic) success output', () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    const out = toModelMessages([
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 't', output: cyclic }] },
    ]) as any[];
    expect(out[0].content[0].output.type).toBe('json');
    expect(typeof out[0].content[0].output.value).toBe('string'); // String(cyclic), not a throw
  });

  it('stringifies a non-string error output for error-text', () => {
    const out = toModelMessages([
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 't', output: { code: 42 }, isError: true }] },
    ]) as any[];
    expect(out[0].content[0].output.type).toBe('error-text');
    expect(typeof out[0].content[0].output.value).toBe('string');
  });

  it('emits one role:tool message with multiple parts for parallel tool calls', () => {
    const out = toModelMessages([
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: 'a', toolName: 't', output: { n: 1 } },
          { type: 'tool-result', toolCallId: 'b', toolName: 't', output: { n: 2 } },
        ],
      },
    ]) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('tool');
    expect(out[0].content).toHaveLength(2);
    expect(out[0].content.map((p: any) => p.toolCallId)).toEqual(['a', 'b']);
  });

  it('splits a message mixing tool-call + tool-result into assistant + tool messages', () => {
    const out = toModelMessages([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 't', input: {} },
          { type: 'tool-result', toolCallId: 'tc0', toolName: 't', output: { ok: true } },
        ],
      },
    ]) as any[];
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('assistant');
    expect(out[0].content[0].type).toBe('tool-call');
    expect(out[1].role).toBe('tool');
    expect(out[1].content[0].type).toBe('tool-result');
  });
});
