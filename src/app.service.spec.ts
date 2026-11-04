import { AppService } from './app.service';

describe('AppService', () => {
  const previous = process.env.WEB_URL;

  afterEach(() => {
    process.env.WEB_URL = previous;
  });

  it('sends visitors to the web app, with a link in case the redirect does not happen', () => {
    process.env.WEB_URL = 'https://orbis.example.com/';

    const page = new AppService().home();

    expect(page).toContain(
      '<meta http-equiv="refresh" content="0; url=https://orbis.example.com">',
    );
    expect(page).toContain('<a href="https://orbis.example.com"');
    expect(page).toContain('Click here if you’re not redirected.');
    expect(page).not.toContain('Under Maintenance');
  });

  it('escapes the web address', () => {
    process.env.WEB_URL = 'https://orbis.example.com/?a="b"&c=<d>';

    const page = new AppService().home();

    expect(page).toContain(
      'https://orbis.example.com/?a=&quot;b&quot;&amp;c=&lt;d&gt;',
    );
    expect(page).not.toContain('"b"');
  });
});
