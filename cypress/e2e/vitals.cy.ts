// aiVitals on the app's own model calls: tokens, time and cost read from the response. Responses are stubbed.
const APP = 'cypress/app/index.html';

function ask() {
  cy.get('[data-cy=question]').type('What is the capital of the USA?');
  cy.get('[data-cy=ask]').click();
}

describe('aiVitals: tokens, time and cost of a call', () => {
  beforeEach(() => cy.visit(APP));

  it('reads OpenAI-style usage and Server-Timing', () => {
    cy.intercept('POST', '/api/chat', {
      headers: { 'server-timing': 'model;dur=842', 'x-ai-model': 'fast' },
      body: { text: 'Washington, D.C.', usage: { prompt_tokens: 120, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 25 } } },
    }).as('chat');
    ask();
    cy.wait('@chat').aiVitals({ latencyMs: 2000, totalTokens: 500, reasoningTokens: 100 });
  });

  it('reads Gemini-style usage', () => {
    cy.intercept('POST', '/api/chat', {
      headers: { 'server-timing': 'model;dur=610', 'x-ai-model': 'gemini' },
      body: { text: 'Washington, D.C.', usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 12, thoughtsTokenCount: 30 } },
    }).as('chat');
    ask();
    cy.wait('@chat').aiVitals({ latencyMs: 2000, outputTokens: 100 });
  });

  it('fails a call that blows its budget', () => {
    cy.intercept('POST', '/api/chat', {
      headers: { 'server-timing': 'model;dur=9000' },
      body: { text: 'Washington, D.C.', usage: { prompt_tokens: 3000, completion_tokens: 2000 } },
    }).as('chat');
    ask();
    // shouldFail: passes because the latency and token budgets catch this slow, expensive call.
    cy.wait('@chat').aiVitals({ latencyMs: 3000, totalTokens: 1000, shouldFail: true });
  });
});

export {};
