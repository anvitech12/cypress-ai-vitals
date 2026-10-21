// aiAudioAssert on an <audio> element: a local Whisper model writes down what it hears. No API key needed.
describe('aiAudioAssert: speech', () => {
  it('checks what a voice says, word by word', () => {
    cy.visit('cypress/app/index.html');
    cy.get('[data-cy=speech]').aiAudioAssert({ transcript: { expected: 'Your order ships tomorrow morning.', maxWer: 0.25, engine: 'local' } });
  });
});

export {};
