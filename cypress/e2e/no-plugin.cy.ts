// Without aiVitalsPlugin in setupNodeEvents, the support file says so in the Command Log, before any AI command fails.
const messages: string[] = [];
const original = Cypress.expose;
const read = original.bind(Cypress) as (key: string) => unknown;
Cypress.on('log:added', (attrs) => messages.push(String(attrs.message ?? '')));
Cypress.expose = ((key: string) => (key === 'aiVitalsPlugin' ? undefined : read(key))) as typeof Cypress.expose;

describe('Without the plugin in setupNodeEvents', () => {
  it('logs how to fix the setup', () => {
    Cypress.expose = original;
    expect(messages.join('\n')).to.contain('aiVitalsPlugin(on, config) is missing from setupNodeEvents');
  });
});
