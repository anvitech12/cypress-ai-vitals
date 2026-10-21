// Real model calls: aiGenerate, aiCompare and the LLM judge. They replay answers recorded once with real models
// (cypress/fixtures/ai-cassettes), so CI needs no API key. Re-record with: npm run test:e2e:record
describe('Models: generate, compare and judge', () => {
  it('calls a model by name and scores its answer', () => {
    cy.aiGenerate('fast', 'What is the capital of the USA? Answer in one sentence.').aiAssert({ means: 'Washington, D.C. is the capital of the United States.', mustMention: ['Washington'], model: 'fast' });
  });

  it('ranks two models on the same questions', () => {
    cy.aiCompare({
      models: ['fast', 'gemini'],
      cases: [
        { input: 'What is the capital of the USA? Answer in one sentence.', expected: 'Washington, D.C. is the capital of the United States.', mustMention: ['Washington'] },
        { input: 'A train leaves at 09:40 and arrives at 13:15. How many minutes is the trip? Reply with the number only.', answer: 215 },
      ],
      system: 'Answer briefly.',
      gates: { accuracy: 0.5 },
    }).then((result) => {
      expect(result.models.map((m) => m.model)).to.have.members(['fast', 'gemini']);
      expect(result.winner).to.be.oneOf(['fast', 'gemini']);
    });
  });

  it('lets another model judge an answer against a rubric', () => {
    const rubric = 'Says that the capital of the USA is Washington, D.C.';
    cy.wrap('Washington, D.C. is the capital of the United States.').aiAssert({ judge: { rubric, min: 4 } });
    // shouldFail: passes because the judge marks the wrong city down.
    cy.wrap('New York is the capital of the United States.').aiAssert({ judge: { rubric, min: 4 }, shouldFail: true });
  });
});

export {};
