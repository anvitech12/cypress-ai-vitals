// aiImageAssert on images in a page: what they show (local CLIP), brand colours and size. No API key needed.
describe('aiImageAssert: images', () => {
  beforeEach(() => cy.visit('cypress/app/index.html'));

  it('checks what an image shows, and tells a cartoon from a photograph', () => {
    cy.get('[data-cy=mascot]').aiImageAssert({ depicts: 'a cartoon fox mascot', notDepicts: ['a photograph of a real fox', 'a dog'] });
    cy.get('[data-cy=photo]').aiImageAssert({ depicts: 'a photograph of a fox in the snow', notDepicts: ['a cartoon'] });
  });

  it('checks brand colours and size', () => {
    cy.get('[data-cy=mascot]').aiImageAssert({ brand: { fixture: 'brand/fox.json' }, dimensions: { minWidth: 256, minHeight: 256 } });
    // shouldFail: passes because the photo does not use the brand's orange.
    cy.get('[data-cy=photo]').aiImageAssert({ brand: { fixture: 'brand/fox.json' }, shouldFail: true });
  });

  it('loads same-site images in the browser, so cy.intercept stubs apply', () => {
    cy.intercept('GET', '/stubbed/fox.jpg', { fixture: 'images/on-brand-1.jpg' });
    cy.wrap('/stubbed/fox.jpg').aiImageAssert({ depicts: 'a cartoon fox mascot', notDepicts: ['a dog'] });
  });

  it('works on an image URL too', () => {
    cy.wrap('/cypress/fixtures/images/two-cats.jpg').aiImageAssert({ depicts: 'cats on a sofa', notDepicts: ['a dog'] });
    // shouldFail: passes because the picture shows cats, not the fox that was asked for.
    cy.wrap('/cypress/fixtures/images/two-cats.jpg').aiImageAssert({ depicts: 'a cartoon fox mascot', shouldFail: true });
  });
});

export {};
