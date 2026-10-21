// The AI Vitals panel in the runner: hidden while tests run, shown when the spec finishes, and its buttons work.
const panel = () => window.top!.document.getElementById('cypress-ai-vitals-panel');
const button = (action: string) => panel()!.querySelector<HTMLElement>(`[data-action=${action}]`)!;

describe('The AI Vitals panel', () => {
  it('collects results without showing the panel during the run', () => {
    // The panel remembers whether the viewer minimized or closed it; start from the default.
    window.top!.localStorage.removeItem('cypress-ai-vitals:panel-state');
    cy.wrap('Washington, D.C. is the capital of the United States.').aiAssert({ mustMention: ['Washington'] });
    cy.wrap('The trip takes 215 minutes.').aiAssert({ exactAnswer: 215 });
    cy.then(() => expect(panel(), 'no panel while tests run').to.equal(null));
  });
});

// Root hooks run in the order they are registered, so this one runs after the plugin's, which shows the panel.
after(() => {
  cy.then(() => {
    expect(panel(), 'panel shown after the spec').to.not.equal(null);
    expect(panel()!.textContent).to.contain('2 of 2 checks');
    button('collapse').click();
    expect(panel()!.dataset.state, 'minimize').to.equal('collapsed');
    button('collapse').click();
    expect(panel()!.dataset.state, 'expand').to.equal('open');
  });
  // Copy writes to the clipboard, which needs a real, trusted click, so it goes through Chrome's DevTools protocol.
  cy.then(() => {
    const r = button('copy').getBoundingClientRect();
    const at = { x: r.left + r.width / 2, y: r.top + r.height / 2, button: 'left', clickCount: 1 };
    const mouse = (type: string) => Cypress.automation('remote:debugger:protocol', { command: 'Input.dispatchMouseEvent', params: { type, ...at } });
    return mouse('mousePressed').then(() => mouse('mouseReleased'));
  });
  cy.wrap(null, { log: false }).should(() => expect(panel()!.querySelector('.foot')!.textContent).to.equal('Copied as Markdown.'));
  cy.then(() => {
    button('close').click();
    expect(panel()!.dataset.state, 'close').to.equal('closed');
    panel()!.querySelector<HTMLElement>('.head')!.click();
    expect(panel()!.dataset.state, 'reopen from the pill').to.equal('open');
  });
});

export {};
