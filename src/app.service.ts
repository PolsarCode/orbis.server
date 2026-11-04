import { Injectable } from '@nestjs/common';
import { webUrl } from './common/web-url';

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

@Injectable()
export class AppService {
  home() {
    const url = escapeHtml(webUrl());
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${url}">
<title>Orbis</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#151613;color:#aca99e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;">
<p>Taking you to Orbis… <a href="${url}" style="color:#f07357;font-weight:600;">Click here if you’re not redirected.</a></p>
</body>
</html>`;
  }
}
