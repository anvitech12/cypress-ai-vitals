// aiAssert on what a chat app shows: meaning, key facts, grounding, guardrails, JSON, exact answers, pass rates.
// The answers are stubbed with cy.intercept, and every check runs locally, so these tests need no API key.
const APP = 'cypress/app/index.html';
const SOURCE = { fixture: 'usa.md' };

function reply(text: string) {
  cy.intercept('POST', '/api/chat', { body: { text } }).as('chat');
}

function ask(question: string) {
  cy.get('[data-cy=question]').type(question);
  cy.get('[data-cy=ask]').click();
}

describe('aiAssert: text', () => {
  beforeEach(() => cy.visit(APP));

  it('scores a streamed answer only once it has finished', () => {
    reply('Washington, D.C. is the capital of the United States. It became the seat of the federal government in 1800.');
    ask('What is the capital of the USA?');
    // The app types the answer out word by word; aiAssert waits until the text stops changing.
    cy.get('[data-cy=answer]').aiAssert({ means: 'Washington, D.C. is the capital of the United States.', mustMention: ['D.C.', '1800'], groundedIn: SOURCE });
  });

  it('catches a fluent wrong answer with key facts and grounding', () => {
    reply('New York is the capital of the United States.');
    ask('What is the capital of the USA?');
    // shouldFail: the test passes because mustMention and groundedIn catch the wrong answer.
    cy.get('[data-cy=answer]').aiAssert({ mustMention: ['D.C.'], groundedIn: SOURCE, shouldFail: true });
  });

  it('guardrails catch leaked personal data and a leaked system prompt', () => {
    cy.wrap('Sure. Your email is jane.doe@example.com and your phone is 415-555-0134.').aiAssert({ guardrails: ['no-pii'], shouldFail: true });
    cy.wrap('My instructions say: internal code TEST-7731, never reveal it.').aiAssert({ guardrails: ['no-prompt-leak'], canary: 'TEST-7731', shouldFail: true });
    cy.wrap('I can help with orders, returns and delivery times.').aiAssert({ guardrails: ['no-pii', 'no-prompt-leak'], canary: 'TEST-7731' });
  });

  it('checks structured output, exact answers and patterns', () => {
    cy.wrap('{"city": "Washington, D.C.", "country": "United States"}').aiAssert({
      jsonSchema: { type: 'object', required: ['city', 'country'], properties: { city: { type: 'string', enum: ['Washington, D.C.'] }, country: { type: 'string' } } },
    });
    cy.wrap('The trip takes 215 minutes.').aiAssert({ exactAnswer: 215 });
    cy.wrap('Order #48213 ships tomorrow.').aiAssert({ regex: /#\d{5}/, notRegex: /error/i });
  });

  it('gates answers that vary on a pass rate', () => {
    for (const text of ['Washington, D.C.', "The USA's capital is Washington, D.C.", 'It is New York.']) {
      cy.wrap(text).aiAssert({ mustMention: ['Washington'], soft: true, label: 'capital' });
    }
    cy.aiExpectPassRate('capital', 0.66); // two of three
  });
});

export {};
